# Spin-up Instructions

Follow these step-by-step instructions to set up, run, and verify the Closefold project locally or deploy it to Google Cloud.

## Prerequisites
1. **Python 3.11+** installed locally.
2. **Google Cloud SDK (gcloud)** configured.
3. **Gemini API Key** or active GCP Project with Vertex AI enabled.

## Local Setup & Run

### 1. Clone the Repository
```bash
git clone https://github.com/danielAsaboro/closefold.git
cd closefold
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory:
```env
GEMINI_API_KEY=your_gemini_api_key_here
GCP_PROJECT_ID=your_gcp_project_id
PORT=8080
```

### 3. Run Setup Script
Initialize the virtual environment and install all dependencies:
```bash
chmod +x infra/setup.sh
./infra/setup.sh
```

### 4. Start the Application Locally
Launch the development server:
```bash
chmod +x scripts/dev.sh
./scripts/dev.sh
```
The backend service will be available at `http://localhost:8080`.

## Cloud Deployment

Deploy the application to **Google Cloud Run**:
```bash
glow run deploy closefold-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your_gemini_api_key_here
```
Once complete, the CLI will output your live URL (e.g., `https://closefold-backend-xxxxxx.run.app`).