#!/bin/bash

# Simple deployment script

echo "🔧 Building Docker image..."
docker build -t my-devops-webapp .

echo "🏷️ Tagging image..."
docker tag my-devops-webapp nanikss/my-devops-webapp:latest

echo "🔐 Logging in to Docker Hub..."
docker login

echo "📤 Pushing image to Docker Hub..."
docker push nanikss/my-devops-webapp:latest

echo "🧹 Cleaning up old container (if any)..."
docker stop my-running-app 2>/dev/null
docker rm my-running-app 2>/dev/null

echo "🚀 Running new container..."
docker run -d -p 3000:3000 --name my-running-app nanikss/my-devops-webapp:latest

echo "✅ App deployed. Visit it at http://<your-public-ip>:3000"
