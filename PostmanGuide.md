# Event AI Server - Postman Collection Guide

Complete guide for testing the Event AI Server REST API using Postman.

## 📋 Quick Setup

### 1. Import Collection

Copy the JSON collection below and import it into Postman:

1. Open Postman
2. Click "Import" button
3. Select "Raw text" tab
4. Paste the collection JSON
5. Click "Continue" and "Import"

### 2. Set Environment Variables

Create a new environment in Postman with these variables:

| Variable | Description | Value |
|----------|-------------|-------|
| `baseUrl` | Server base URL | `http://localhost:3000` |
| `apiVersion` | API version | `v1` |
| `eventId` | Sample event ID | `evt_123456789` |
| `simulationId` | Sample simulation ID | `sim_123456789` |

## 🚀 Postman Collection JSON

```json
{
  "info": {
    "name": "Event AI Server API",
    "description": "Complete API collection for Event AI Server with crowd simulation and management capabilities.",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    "_postman_id": "event-ai-server-collection",
    "version": {
      "major": 1,
      "minor": 0,
      "patch": 0
    }
  },
  "item": [
    {
      "name": "System",
      "description": "System health and information endpoints",
      "item": [
        {
          "name": "Root Endpoint",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/",
              "host": ["{{baseUrl}}"],
              "path": [""]
            },
            "description": "Get server information and available endpoints"
          },
          "response": [
            {
              "name": "Success Response",
              "originalRequest": {
                "method": "GET",
                "header": [],
                "url": {
                  "raw": "{{baseUrl}}/",
                  "host": ["{{baseUrl}}"],
                  "path": [""]
                }
              },
              "status": "OK",
              "code": 200,
              "_postman_previewlanguage": "json",
              "header": [
                {
                  "key": "Content-Type",
                  "value": "application/json"
                }
              ],
              "cookie": [],
              "body": "{\n  \"message\": \"Event AI Server\",\n  \"version\": \"1.0.0\",\n  \"environment\": \"development\",\n  \"timestamp\": \"2024-01-01T12:00:00.000Z\",\n  \"documentation\": {\n    \"swagger\": \"http://localhost:3000/api-docs\",\n    \"openapi\": \"http://localhost:3000/api-docs.json\"\n  },\n  \"endpoints\": {\n    \"health\": \"http://localhost:3000/health\",\n    \"events\": \"http://localhost:3000/api/v1/events\",\n    \"simulations\": \"http://localhost:3000/api/v1/simulations\"\n  }\n}"
            }
          ]
        },
        {
          "name": "Health Check",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/health",
              "host": ["{{baseUrl}}"],
              "path": ["health"]
            },
            "description": "Check server health and get system metrics"
          },
          "response": [
            {
              "name": "Healthy Response",
              "originalRequest": {
                "method": "GET",
                "header": [],
                "url": {
                  "raw": "{{baseUrl}}/health",
                  "host": ["{{baseUrl}}"],
                  "path": ["health"]
                }
              },
              "status": "OK",
              "code": 200,
              "_postman_previewlanguage": "json",
              "header": [
                {
                  "key": "Content-Type",
                  "value": "application/json"
                }
              ],
              "cookie": [],
              "body": "{\n  \"status\": \"healthy\",\n  \"timestamp\": \"2024-01-01T12:00:00.000Z\",\n  \"version\": \"1.0.0\",\n  \"environment\": \"development\",\n  \"uptime\": 3600,\n  \"memoryUsage\": {\n    \"rss\": 45678912,\n    \"heapTotal\": 18874368,\n    \"heapUsed\": 12345678,\n    \"external\": 1234567\n  }\n}"
            }
          ]
        }
      ]
    },
    {
      "name": "Events",
      "description": "Event management operations",
      "item": [
        {
          "name": "Create Event",
          "request": {
            "method": "POST",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"name\": \"Summer Music Festival 2024\",\n  \"description\": \"Annual outdoor music festival featuring top artists from around the world\",\n  \"venue\": \"Central Park\",\n  \"expectedAttendees\": 5000,\n  \"eventDate\": \"2024-07-15T18:00:00Z\",\n  \"eventType\": \"FESTIVAL\"\n}",
              "options": {
                "raw": {
                  "language": "json"
                }
              }
            },
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/events",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "events"]
            },
            "description": "Create a new event with basic information"
          },
          "response": [
            {
              "name": "Event Created",
              "originalRequest": {
                "method": "POST",
                "header": [
                  {
                    "key": "Content-Type",
                    "value": "application/json"
                  }
                ],
                "body": {
                  "mode": "raw",
                  "raw": "{\n  \"name\": \"Summer Music Festival 2024\",\n  \"description\": \"Annual outdoor music festival\",\n  \"venue\": \"Central Park\",\n  \"expectedAttendees\": 5000,\n  \"eventDate\": \"2024-07-15T18:00:00Z\",\n  \"eventType\": \"FESTIVAL\"\n}"
                },
                "url": {
                  "raw": "{{baseUrl}}/api/v1/events",
                  "host": ["{{baseUrl}}"],
                  "path": ["api", "v1", "events"]
                }
              },
              "status": "Created",
              "code": 201,
              "_postman_previewlanguage": "json",
              "header": [
                {
                  "key": "Content-Type",
                  "value": "application/json"
                }
              ],
              "cookie": [],
              "body": "{\n  \"success\": true,\n  \"data\": {\n    \"eventId\": \"evt_1234567890\",\n    \"simulationId\": \"sim_1234567890\"\n  },\n  \"message\": \"Event created successfully\"\n}"
            }
          ]
        },
        {
          "name": "Create Event with File Upload",
          "request": {
            "method": "POST",
            "header": [],
            "body": {
              "mode": "formdata",
              "formdata": [
                {
                  "key": "name",
                  "value": "Tech Conference 2024",
                  "type": "text"
                },
                {
                  "key": "description",
                  "value": "Annual technology conference with industry leaders",
                  "type": "text"
                },
                {
                  "key": "venue",
                  "value": "Convention Center",
                  "type": "text"
                },
                {
                  "key": "expectedAttendees",
                  "value": "2000",
                  "type": "text"
                },
                {
                  "key": "eventDate",
                  "value": "2024-09-20T09:00:00Z",
                  "type": "text"
                },
                {
                  "key": "eventType",
                  "value": "CONFERENCE",
                  "type": "text"
                },
                {
                  "key": "ticketingData",
                  "type": "file",
                  "src": []
                },
                {
                  "key": "seatingChart",
                  "type": "file",
                  "src": []
                }
              ]
            },
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/events",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "events"]
            },
            "description": "Create event with file uploads for ticketing data and seating chart"
          }
        },
        {
          "name": "Get All Events",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/events?page=1&limit=10",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "events"],
              "query": [
                {
                  "key": "page",
                  "value": "1",
                  "description": "Page number (1-based)"
                },
                {
                  "key": "limit",
                  "value": "10",
                  "description": "Number of events per page"
                }
              ]
            },
            "description": "Get paginated list of all events"
          }
        },
        {
          "name": "Get Event by ID",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/events/{{eventId}}",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "events", "{{eventId}}"]
            },
            "description": "Get specific event details by ID"
          }
        },
        {
          "name": "Update Event",
          "request": {
            "method": "PUT",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"name\": \"Updated Summer Music Festival 2024\",\n  \"description\": \"Updated description for the music festival\",\n  \"venue\": \"Updated Central Park Location\",\n  \"expectedAttendees\": 6000,\n  \"eventDate\": \"2024-07-16T18:00:00Z\",\n  \"eventType\": \"FESTIVAL\"\n}",
              "options": {
                "raw": {
                  "language": "json"
                }
              }
            },
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/events/{{eventId}}",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "events", "{{eventId}}"]
            },
            "description": "Update existing event information"
          }
        },
        {
          "name": "Delete Event",
          "request": {
            "method": "DELETE",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/events/{{eventId}}",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "events", "{{eventId}}"]
            },
            "description": "Delete an event and its associated simulation"
          }
        }
      ]
    },
    {
      "name": "Simulations",
      "description": "AI simulation operations",
      "item": [
        {
          "name": "Trigger Simulation",
          "request": {
            "method": "POST",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"parameters\": {\n    \"crowdDensityThreshold\": 0.7,\n    \"simulationDuration\": 3600,\n    \"weatherConditions\": \"sunny\",\n    \"emergencyScenario\": false\n  }\n}",
              "options": {
                "raw": {
                  "language": "json"
                }
              }
            },
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/simulations/{{simulationId}}/trigger",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "simulations", "{{simulationId}}", "trigger"]
            },
            "description": "Start AI simulation for crowd flow analysis"
          },
          "response": [
            {
              "name": "Simulation Started",
              "originalRequest": {
                "method": "POST",
                "header": [
                  {
                    "key": "Content-Type",
                    "value": "application/json"
                  }
                ],
                "body": {
                  "mode": "raw",
                  "raw": "{\n  \"parameters\": {\n    \"crowdDensityThreshold\": 0.7,\n    \"simulationDuration\": 3600,\n    \"weatherConditions\": \"sunny\"\n  }\n}"
                },
                "url": {
                  "raw": "{{baseUrl}}/api/v1/simulations/sim_123/trigger",
                  "host": ["{{baseUrl}}"],
                  "path": ["api", "v1", "simulations", "sim_123", "trigger"]
                }
              },
              "status": "OK",
              "code": 200,
              "_postman_previewlanguage": "json",
              "header": [
                {
                  "key": "Content-Type",
                  "value": "application/json"
                }
              ],
              "cookie": [],
              "body": "{\n  \"success\": true,\n  \"data\": {\n    \"simulationId\": \"sim_123456789\",\n    \"status\": \"RUNNING\",\n    \"startedAt\": \"2024-01-01T12:00:00.000Z\"\n  },\n  \"message\": \"Simulation started successfully\"\n}"
            }
          ]
        },
        {
          "name": "Get Simulation Status",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/simulations/{{simulationId}}/status",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "simulations", "{{simulationId}}", "status"]
            },
            "description": "Get current status of a running or completed simulation"
          },
          "response": [
            {
              "name": "Running Simulation",
              "originalRequest": {
                "method": "GET",
                "header": [],
                "url": {
                  "raw": "{{baseUrl}}/api/v1/simulations/sim_123/status",
                  "host": ["{{baseUrl}}"],
                  "path": ["api", "v1", "simulations", "sim_123", "status"]
                }
              },
              "status": "OK",
              "code": 200,
              "_postman_previewlanguage": "json",
              "header": [
                {
                  "key": "Content-Type",
                  "value": "application/json"
                }
              ],
              "cookie": [],
              "body": "{\n  \"success\": true,\n  \"data\": {\n    \"simulationId\": \"sim_123456789\",\n    \"status\": \"RUNNING\",\n    \"progress\": {\n      \"percentage\": 65,\n      \"currentStep\": \"Analyzing crowd patterns\",\n      \"estimatedTimeRemaining\": 420\n    },\n    \"startedAt\": \"2024-01-01T12:00:00.000Z\"\n  }\n}"
            }
          ]
        },
        {
          "name": "Get Simulation Results",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/simulations/{{simulationId}}/results",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "simulations", "{{simulationId}}", "results"]
            },
            "description": "Get results from a completed simulation"
          },
          "response": [
            {
              "name": "Completed Simulation Results",
              "originalRequest": {
                "method": "GET",
                "header": [],
                "url": {
                  "raw": "{{baseUrl}}/api/v1/simulations/sim_123/results",
                  "host": ["{{baseUrl}}"],
                  "path": ["api", "v1", "simulations", "sim_123", "results"]
                }
              },
              "status": "OK",
              "code": 200,
              "_postman_previewlanguage": "json",
              "header": [
                {
                  "key": "Content-Type",
                  "value": "application/json"
                }
              ],
              "cookie": [],
              "body": "{\n  \"success\": true,\n  \"data\": {\n    \"simulationId\": \"sim_123456789\",\n    \"status\": \"COMPLETED\",\n    \"results\": {\n      \"summary\": {\n        \"totalAttendees\": 4850,\n        \"peakCrowdDensity\": 0.85,\n        \"averageWaitTime\": 12.5,\n        \"bottleneckAreas\": [\"Main Entrance\", \"Food Court\"]\n      },\n      \"recommendations\": [\n        {\n          \"id\": \"rec_001\",\n          \"type\": \"CROWD_CONTROL\",\n          \"priority\": \"HIGH\",\n          \"title\": \"Deploy Additional Staff at Main Entrance\",\n          \"description\": \"High congestion detected at main entrance\",\n          \"estimatedImpact\": \"Reduce wait time by 60%\",\n          \"implementationTime\": \"10 minutes\"\n        }\n      ]\n    },\n    \"completedAt\": \"2024-01-01T13:00:00.000Z\"\n  }\n}"
            }
          ]
        },
        {
          "name": "Get All Simulations",
          "request": {
            "method": "GET",
            "header": [
              {
                "key": "Content-Type",
                "value": "application/json"
              }
            ],
            "url": {
              "raw": "{{baseUrl}}/api/{{apiVersion}}/simulations?page=1&limit=10&status=COMPLETED",
              "host": ["{{baseUrl}}"],
              "path": ["api", "{{apiVersion}}", "simulations"],
              "query": [
                {
                  "key": "page",
                  "value": "1",
                  "description": "Page number"
                },
                {
                  "key": "limit",
                  "value": "10",
                  "description": "Items per page"
                },
                {
                  "key": "status",
                  "value": "COMPLETED",
                  "description": "Filter by status"
                }
              ]
            },
            "description": "Get paginated list of simulations with optional filtering"
          }
        }
      ]
    }
  ],
  "event": [
    {
      "listen": "prerequest",
      "script": {
        "type": "text/javascript",
        "exec": [
          "// Auto-generate test data if variables are not set",
          "if (!pm.environment.get('eventId')) {",
          "    pm.environment.set('eventId', 'evt_' + Math.random().toString(36).substr(2, 9));",
          "}",
          "",
          "if (!pm.environment.get('simulationId')) {",
          "    pm.environment.set('simulationId', 'sim_' + Math.random().toString(36).substr(2, 9));",
          "}",
          "",
          "// Set timestamp for requests",
          "pm.environment.set('timestamp', new Date().toISOString());"
        ]
      }
    },
    {
      "listen": "test",
      "script": {
        "type": "text/javascript",
        "exec": [
          "// Global test to check response format",
          "pm.test('Response has correct format', function () {",
          "    const jsonData = pm.response.json();",
          "    pm.expect(jsonData).to.have.property('success');",
          "    ",
          "    if (jsonData.success) {",
          "        pm.expect(jsonData).to.have.property('data');",
          "    } else {",
          "        pm.expect(jsonData).to.have.property('error');",
          "    }",
          "});",
          "",
          "// Store IDs from responses for subsequent requests",
          "if (pm.response.code === 201) {",
          "    const jsonData = pm.response.json();",
          "    if (jsonData.data && jsonData.data.eventId) {",
          "        pm.environment.set('eventId', jsonData.data.eventId);",
          "    }",
          "    if (jsonData.data && jsonData.data.simulationId) {",
          "        pm.environment.set('simulationId', jsonData.data.simulationId);",
          "    }",
          "}"
        ]
      }
    }
  ],
  "variable": [
    {
      "key": "baseUrl",
      "value": "http://localhost:3000",
      "type": "string"
    },
    {
      "key": "apiVersion",
      "value": "v1",
      "type": "string"
    }
  ]
}
```

## 🔧 Testing Workflows

### **Workflow 1: Complete Event Lifecycle**

1. **Create Event** → Store `eventId` and `simulationId`
2. **Get Event by ID** → Verify event details
3. **Trigger Simulation** → Start AI analysis
4. **Check Simulation Status** → Monitor progress
5. **Get Simulation Results** → Retrieve recommendations
6. **Update Event** → Modify event details
7. **Delete Event** → Clean up

### **Workflow 2: Batch Operations**

1. **Get All Events** → List existing events
2. **Get All Simulations** → List all simulations
3. **Filter by Status** → Use query parameters

### **Workflow 3: File Upload Testing**

1. **Create Event with Files** → Upload ticketing data and seating chart
2. **Verify File Storage** → Check S3 integration

## 📝 Environment Setup Guide

### **Local Development Environment**

```json
{
  "name": "Event AI - Local",
  "values": [
    {
      "key": "baseUrl",
      "value": "http://localhost:3000",
      "enabled": true
    },
    {
      "key": "apiVersion",
      "value": "v1",
      "enabled": true
    },
    {
      "key": "eventId",
      "value": "evt_test123",
      "enabled": true
    },
    {
      "key": "simulationId",
      "value": "sim_test123",
      "enabled": true
    }
  ]
}
```

### **Production Environment**

```json
{
  "name": "Event AI - Production",
  "values": [
    {
      "key": "baseUrl",
      "value": "https://your-domain.com",
      "enabled": true
    },
    {
      "key": "apiVersion",
      "value": "v1",
      "enabled": true
    },
    {
      "key": "apiKey",
      "value": "your-production-api-key",
      "enabled": true
    }
  ]
}
```

## 🧪 Test Cases

### **1. Event Creation Tests**

```javascript
// Test: Event creation with minimum required fields
pm.test("Event created with minimum fields", function () {
    pm.expect(pm.response.code).to.equal(201);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.data.eventId).to.match(/^evt_/);
    pm.expect(jsonData.data.simulationId).to.match(/^sim_/);
});

// Test: Event creation with all fields
pm.test("Event created with all fields", function () {
    pm.expect(pm.response.code).to.equal(201);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data).to.have.property('eventId');
    pm.expect(jsonData.data).to.have.property('simulationId');
});
```

### **2. Simulation Tests**

```javascript
// Test: Simulation trigger
pm.test("Simulation triggered successfully", function () {
    pm.expect(pm.response.code).to.equal(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data.status).to.equal('RUNNING');
});

// Test: Simulation status check
pm.test("Simulation status retrieved", function () {
    pm.expect(pm.response.code).to.equal(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data).to.have.property('status');
    pm.expect(jsonData.data).to.have.property('progress');
});
```

### **3. Error Handling Tests**

```javascript
// Test: 404 for non-existent event
pm.test("Returns 404 for non-existent event", function () {
    pm.expect(pm.response.code).to.equal(404);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.false;
    pm.expect(jsonData.error).to.include('not found');
});

// Test: Validation errors
pm.test("Returns validation errors", function () {
    pm.expect(pm.response.code).to.equal(400);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.false;
    pm.expect(jsonData).to.have.property('error');
});
```

## 🔍 Debugging Tips

### **1. Check Response Times**
```javascript
pm.test("Response time is less than 2000ms", function () {
    pm.expect(pm.response.responseTime).to.be.below(2000);
});
```

### **2. Validate Response Structure**
```javascript
pm.test("Response has required fields", function () {
    const jsonData = pm.response.json();
    pm.expect(jsonData).to.have.property('success');
    
    if (jsonData.success) {
        pm.expect(jsonData).to.have.property('data');
    } else {
        pm.expect(jsonData).to.have.property('error');
    }
});
```

### **3. Extract Dynamic Values**
```javascript
// Extract event ID from response
const jsonData = pm.response.json();
if (jsonData.data && jsonData.data.eventId) {
    pm.environment.set('eventId', jsonData.data.eventId);
    console.log('Event ID set to:', jsonData.data.eventId);
}
```

## 📊 API Documentation Links

- **Swagger UI**: `http://localhost:3000/api-docs`
- **OpenAPI JSON**: `http://localhost:3000/api-docs.json`
- **Health Check**: `http://localhost:3000/health`

## 🚀 Quick Start Commands

```bash
# Start server
npm run dev

# Install dependencies (if not done)
npm install

# Check health
curl http://localhost:3000/health

# Test basic endpoint
curl http://localhost:3000/
```

## 💡 Pro Tips

1. **Use Environment Variables**: Set up different environments for local, staging, and production
2. **Chain Requests**: Use test scripts to extract IDs and pass them to subsequent requests
3. **Validate Responses**: Always check both success and error cases
4. **Monitor Performance**: Add response time tests
5. **Test File Uploads**: Use the multipart/form-data request for file uploads
6. **Check Documentation**: Visit `/api-docs` for interactive testing

## 🔗 Related Resources

- [Postman Documentation](https://learning.postman.com/)
- [Event AI Server Swagger UI](http://localhost:3000/api-docs)
- [Express.js Documentation](https://expressjs.com/)
- [Supabase API Reference](https://supabase.com/docs/reference/javascript)

---

**Happy Testing!** 🎉

For issues or questions, check the server logs or visit the health endpoint for system status.
