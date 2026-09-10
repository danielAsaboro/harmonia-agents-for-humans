import json
import unittest
from harmonia_agent.sqs_transport import deliver_message, decode_message

class Client:
    def __init__(self): self.deleted = []
    def delete_message(self, **kw): self.deleted.append(kw)

class QueueDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def message(self, **body):
        return {'Body': json.dumps(body or {'data': {'jobId':'one'}, 'attributes': {'workspaceId':'w'}}), 'MessageId':'m', 'ReceiptHandle':'r', 'Attributes':{'ApproximateReceiveCount':'2'}}
    async def test_ack_only_after_durable_success(self):
        client = Client()
        seen=[]
        async def handle(data, attrs, message_id, attempt):
            seen.append((data,attrs,message_id,attempt)); return True
        self.assertTrue(await deliver_message(client, 'queue', self.message(), handle))
        self.assertEqual(seen[0][2:], ('m',1))
        self.assertEqual(client.deleted, [{'QueueUrl':'queue','ReceiptHandle':'r'}])
    async def test_retry_is_not_deleted(self):
        client=Client()
        async def handle(*args): return False
        self.assertFalse(await deliver_message(client,'queue',self.message(),handle))
        self.assertEqual(client.deleted,[])
    async def test_exception_is_not_deleted(self):
        client=Client()
        async def handle(*args): raise TimeoutError('lost provider response')
        self.assertFalse(await deliver_message(client,'queue',self.message(),handle))
        self.assertEqual(client.deleted,[])
    async def test_poison_message_goes_to_redrive_not_silent_ack(self):
        client=Client()
        async def handle(*args): self.fail('invalid message dispatched')
        self.assertFalse(await deliver_message(client,'queue',self.message(wrong=True),handle))
        self.assertEqual(client.deleted,[])
    def test_attributes_must_be_strings(self):
        with self.assertRaises(ValueError): decode_message(self.message(data={},attributes={'scope':3}))
