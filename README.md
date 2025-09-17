# Event AI Server

A Node.js backend for the Event AI platform, built for AWS EC2 deployment with S3 storage and Supabase database. This server handles event management, AI-powered crowd simulation, and real-time notifications.

## 🏗️ Architecture

The server follows a modern cloud architecture using AWS and Supabase:

- **AWS EC2**: Virtual server hosting the Node.js application
- **Express.js**: Web application framework with REST API endpoints
- **Amazon S3**: File storage for datasets and charts
- **Supabase (PostgreSQL)**: Event and simulation data storage
- **Amazon SageMaker**: AI model inference endpoint
- **n8n Webhook**: WhatsApp notification integration
- **PM2**: Process management for production deployment

## 🚀 Features

- **Event Management**: Create, update, and manage events with file uploads
- **AI Simulation**: Trigger crowd flow simulations with real-time progress tracking
- **Real-time Notifications**: WhatsApp alerts via n8n workflow integration for high-priority recommendations
- **File Management**: Secure S3 integration for ticketing data and seating charts
- **n8n Integration**: Complete workflow automation for webhook processing and WhatsApp delivery
- **Comprehensive Logging**: Winston-based logging with request tracking
- **Error Handling**: Centralized error handling with proper HTTP status codes
- **Security**: Rate limiting, CORS, security headers, and input validation
- **Database**: Supabase PostgreSQL for data persistence with real-time features

## 📁 Project Structure

```
event-ai-server/
├── src/
│   ├── controllers/
│   │   ├── eventController.js       # Event management endpoints
│   │   └── simulationController.js  # Simulation management endpoints
│   ├── services/
│   │   ├── s3Service.js            # AWS S3 file operations
│   │   ├── supabaseService.js      # Database operations with Supabase
│   │   ├── aiModelService.js       # AI model integration
│   │   └── notificationService.js  # WhatsApp/n8n notifications
│   ├── utils/
│   │   └── errorHandler.js         # Error handling utilities
│   └── server.js                   # Main Express server
├── supabase/
│   └── schema.sql                  # Database schema
├── scripts/
│   ├── setup-s3.js               # S3 bucket configuration
│   └── setup-supabase.js         # Supabase setup and testing
├── package.json                   # Dependencies and scripts
├── ecosystem.config.js           # PM2 configuration
└── env.example                   # Environment variables template
```

## 🛠️ Setup & Installation

### Prerequisites

- Node.js 18+ 
- AWS CLI configured with appropriate permissions
- PostgreSQL database (local or RDS)
- Serverless Framework CLI

### Installation

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd event-ai-server
npm install
```

2. **Configure environment variables:**
```bash
cp env.example .env
# Edit .env with your actual configuration values
```

3. **Set up the database:**
```bash
# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev --name init
```

4. **Deploy to AWS:**
```bash
# Deploy to development stage
npm run deploy

# Deploy to production
serverless deploy --stage prod
```

### Local Development

```bash
# Start local development server
npm run dev

# Run with serverless offline
serverless offline
```

## 🔧 Environment Variables

Create a `.env` file based on `env.example`:

```bash
# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
S3_BUCKET_NAME=event-ai-storage

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/eventai_db

# AI Model
SAGEMAKER_ENDPOINT_NAME=event-ai-model-endpoint
# OR use custom API
AI_MODEL_API_URL=https://your-ai-api.com/predict
AI_MODEL_API_KEY=your_api_key

# n8n Integration (Primary notification method)
N8N_WEBHOOK_URL=https://your-n8n.com/webhook/event-ai-alert
NOTIFICATION_RECIPIENTS=+1234567890,+0987654321

# WhatsApp Direct API (Fallback method)
WHATSAPP_API_URL=https://api.whatsapp.com/send
WHATSAPP_API_KEY=your_whatsapp_api_key
```

## 📚 API Endpoints

### Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/events` | Create a new event |
| GET | `/api/v1/events` | List all events (paginated) |
| GET | `/api/v1/events/:eventId` | Get event details |
| PUT | `/api/v1/events/:eventId` | Update an event |
| DELETE | `/api/v1/events/:eventId` | Delete an event |

### Simulations

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/simulations/run` | Start AI simulation |
| GET | `/api/v1/simulations/:simulationId/status` | Get simulation status |
| GET | `/api/v1/simulations/:simulationId/results` | Get simulation results |
| GET | `/api/v1/simulations/:simulationId` | Get simulation details |
| DELETE | `/api/v1/simulations/:simulationId` | Cancel/delete simulation |
| GET | `/api/v1/simulations` | List simulations (filtered) |

### Example Requests

**Create Event:**
```bash
curl -X POST https://your-api-gateway-url/api/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Summer Music Festival",
    "venue": "Central Park",
    "expectedAttendees": 5000,
    "eventDate": "2024-07-15T18:00:00Z",
    "eventType": "festival",
    "ticketingData": {...},
    "seatingChart": {...}
  }'
```

**Start Simulation:**
```bash
curl -X POST https://your-api-gateway-url/api/v1/simulations/run \
  -H "Content-Type: application/json" \
  -d '{
    "simulationId": "sim_12345",
    "parameters": {
      "crowdDensityThreshold": 0.8,
      "simulationDuration": 3600,
      "weatherConditions": "sunny"
    }
  }'
```

## 🔐 Security Features

- **Rate Limiting**: 100 requests per 15 minutes per IP
- **CORS**: Configurable allowed origins
- **Security Headers**: XSS protection, content type options, frame options
- **Input Validation**: Express-validator for request validation
- **Error Handling**: No sensitive information leaked in production
- **Request Timeout**: 30-second default timeout
- **AWS IAM**: Least-privilege permissions for AWS services

## 📊 Monitoring & Logging

- **Winston Logging**: Structured JSON logs with multiple levels
- **Request Tracking**: Unique request IDs for tracing
- **Error Tracking**: Comprehensive error logging with context
- **CloudWatch Integration**: Automatic log aggregation in AWS
- **Health Check**: `/health` endpoint for monitoring

## 🔗 n8n WhatsApp Integration

This server includes a complete n8n workflow integration for WhatsApp notifications:

### Setup n8n Workflow
1. Import the workflow from `n8n-workflow.json`
2. Configure WhatsApp Business API credentials
3. Set up environment variables in n8n
4. Update your server's `N8N_WEBHOOK_URL` environment variable

### Test the Integration
```bash
# Test the n8n webhook integration
node test-webhook.js

# Set environment variables for testing
export N8N_WEBHOOK_URL="https://your-n8n-instance.com/webhook/event-ai-alert"
export TEST_RECIPIENTS="+1234567890,+0987654321"
```

### Webhook Payload Format
The server sends structured data to n8n:
```json
{
  "simulationId": "sim_12345",
  "message": "Event AI simulation completed",
  "recipients": ["+1234567890"],
  "timestamp": "2024-01-01T12:00:00Z",
  "priority": "high",
  "type": "whatsapp_alert",
  "recommendations": [
    {
      "id": "rec_1",
      "type": "CROWD_CONTROL",
      "priority": "HIGH",
      "title": "Deploy Additional Staff",
      "description": "High congestion detected",
      "estimatedImpact": "Reduce wait time by 60%",
      "implementationTime": "10 minutes"
    }
  ]
}
```

For detailed setup instructions, see `n8n-setup-guide.md`.

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix

# Test n8n webhook integration
node test-webhook.js
```

## 📦 Deployment

### Development
```bash
serverless deploy --stage dev
```

### Production
```bash
serverless deploy --stage prod
```

### Environment-specific Configuration

The `serverless.yml` supports multiple stages with different configurations:

- **dev**: Development environment with debug logging
- **staging**: Staging environment for testing
- **prod**: Production environment with optimized settings

## 🔧 Database Management

```bash
# Generate Prisma client after schema changes
npx prisma generate

# Create and apply migrations
npx prisma migrate dev --name description

# Reset database (development only)
npx prisma migrate reset

# View database in Prisma Studio
npx prisma studio
```

## 🚨 Error Handling

The server implements comprehensive error handling:

- **Custom AppError Class**: Structured error responses
- **AWS SDK Errors**: Specific handling for AWS service errors
- **Database Errors**: Prisma error translation
- **Validation Errors**: Express-validator integration
- **Global Error Handler**: Centralized error processing

## 📈 Performance Optimization

- **Connection Pooling**: Database connection optimization
- **Async Operations**: Non-blocking I/O operations
- **Request Caching**: Appropriate cache headers
- **Compression**: API Gateway compression enabled
- **Cold Start Optimization**: Minimal dependencies and optimized imports

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:

- Create an issue in the repository
- Check the documentation
- Review the logs in CloudWatch

## 🔄 Version History

- **v1.0.0**: Initial release with core functionality
  - Event management
  - AI simulation integration
  - WhatsApp notifications
  - AWS serverless deployment

