import {DynamoDBClient,CreateTableCommand,DescribeTableCommand} from '@aws-sdk/client-dynamodb';
import {S3Client,CreateBucketCommand,PutBucketVersioningCommand} from '@aws-sdk/client-s3';
const endpoint=process.env.AWS_LOCAL_ENDPOINT;
const s3endpoint=process.env.AWS_S3_LOCAL_ENDPOINT;
for(const value of [endpoint,s3endpoint]) {
 if(!value || !['127.0.0.1','localhost'].includes(new URL(value).hostname)) throw new Error('Local test endpoints required');
}
const credentials={accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY};
const ddb=new DynamoDBClient({endpoint,region:'us-east-1',credentials,maxAttempts:1});
let ready=false;
for(let i=0;i<60;i++){
 try {await ddb.send(new CreateTableCommand({TableName:process.env.DYNAMODB_TABLE,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]}));ready=true;break;}
 catch(error){if(error.name==='ResourceInUseException'){ready=true;break;} await new Promise(r=>setTimeout(r,500));}
}
if(!ready) throw new Error('DynamoDB Local did not start');
await ddb.send(new DescribeTableCommand({TableName:process.env.DYNAMODB_TABLE}));
const client=new S3Client({endpoint:s3endpoint,region:'us-east-1',credentials,forcePathStyle:true});
await client.send(new CreateBucketCommand({Bucket:process.env.S3_BUCKET}));
await client.send(new PutBucketVersioningCommand({Bucket:process.env.S3_BUCKET,VersioningConfiguration:{Status:'Enabled'}}));
process.send?.('ready');
console.log('LOCAL_DATA_SERVICES_READY');
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{process.exit(0);});

// Parent shell owns MinIO and DynamoDB lifecycles.
setInterval(() => {}, 60_000);
