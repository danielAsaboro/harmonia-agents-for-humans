"""SQS delivery with explicit acknowledgement and visibility renewal.

Failures, malformed envelopes and uncertain effects remain on the queue for
configured redrive; the application claim is the authority for replay safety.
"""
from __future__ import annotations
import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger(__name__)
Handler = Callable[[dict[str, Any], dict[str, str], str, int], Awaitable[bool]]


def decode_message(message: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str], str, int]:
    body = json.loads(message['Body'])
    if not isinstance(body, dict) or set(body) != {'data', 'attributes'}:
        raise ValueError('invalid SQS envelope')
    data, attributes = body['data'], body['attributes']
    if not isinstance(data, dict) or not isinstance(attributes, dict):
        raise ValueError('invalid SQS data/carrier')
    if any(not isinstance(k, str) or not isinstance(v, str) for k, v in attributes.items()):
        raise ValueError('invalid SQS carrier value')
    message_id = message['MessageId']
    if not isinstance(message_id, str) or not message_id or not message.get('ReceiptHandle'):
        raise ValueError('missing SQS delivery identity')
    attempt = int(message.get('Attributes', {}).get('ApproximateReceiveCount', '1')) - 1
    if attempt < 0:
        raise ValueError('invalid SQS receive count')
    return data, attributes, message_id, attempt


async def deliver_message(client: Any, queue_url: str, message: dict[str, Any], handler: Handler) -> bool:
    try:
        data, attributes, message_id, attempt = decode_message(message)
        if not await handler(data, attributes, message_id, attempt):
            return False
        await asyncio.to_thread(client.delete_message, QueueUrl=queue_url, ReceiptHandle=message['ReceiptHandle'])
        return True
    except Exception as exc:
        # Do not log source material or credentials included in transport errors.
        log.warning('SQS delivery retained for recovery: %s', type(exc).__name__)
        return False


async def _renew_visibility(client: Any, queue_url: str, receipt: str) -> None:
    while True:
        await asyncio.sleep(45)
        await asyncio.to_thread(client.change_message_visibility, QueueUrl=queue_url,
                                ReceiptHandle=receipt, VisibilityTimeout=120)


async def consume(queue_url: str, handler: Handler, *, region: str) -> None:
    import boto3
    client = boto3.client('sqs', region_name=region)
    while True:
        try:
            response = await asyncio.to_thread(client.receive_message, QueueUrl=queue_url,
                MaxNumberOfMessages=1, WaitTimeSeconds=20, VisibilityTimeout=120,
                MessageSystemAttributeNames=['ApproximateReceiveCount'])
            for message in response.get('Messages', []):
                renewal = asyncio.create_task(_renew_visibility(client, queue_url, message['ReceiptHandle']))
                try:
                    await deliver_message(client, queue_url, message, handler)
                finally:
                    renewal.cancel()
                    await asyncio.gather(renewal, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning('SQS receive failed: %s', type(exc).__name__)
            await asyncio.sleep(5)
