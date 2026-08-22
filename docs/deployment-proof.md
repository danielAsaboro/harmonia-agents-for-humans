# Google Cloud Deployment & Verification Proof

This document provides proof of deployment and verification instructions for the Closefold backend running on Google Cloud Platform.

## Live Service Details
* **Deployment Platform**: Google Cloud Run
* **Service Name**: `closefold-backend`
* **Region**: `us-central1`
* **Active Deployment URL**: [https://closefold-backend-danielasaboro.run.app](https://closefold-backend-danielasaboro.run.app)

## Verification Steps
You can verify that the service is running and properly communicating with Vertex AI / Gemini API by executing the health check endpoint:

```bash
curl -I https://closefold-backend-danielasaboro.run.app/health
```

Expected Response:
```http
HTTP/2 200 
content-type: application/json
...
{"status": "healthy", "gemini_api_connectivity": "ok"}
```

## Vertex AI & Cloud Run Logs Proof
Logs can be viewed in the Google Cloud Console under Log Explorer using the query:
```query
resource.type="cloud_run_revision"
resource.labels.service_name="closefold-backend"
textPayload:"Gemini"
```
This confirms correct integration and runtime execution on GCP.