module.exports = {
  apps: [
    {
      name: 'event-ai-server',
      script: './src/server.js',
      instances: 'max', // Use all available CPU cores
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3000
      },
      // Logging configuration
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Auto restart configuration
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      
      // Advanced PM2 features
      kill_timeout: 5000,
      listen_timeout: 3000,
      
      // Environment-specific settings
      merge_logs: true,
      combine_logs: true,
      
      // Health check
      health_check_http: {
        path: '/health',
        port: 3000,
        interval: 30000,
        timeout: 10000
      }
    }
  ],

  deploy: {
    production: {
      user: 'ubuntu',
      host: ['your-ec2-instance-ip'],
      ref: 'origin/main',
      repo: 'your-git-repository-url',
      path: '/home/ubuntu/event-ai-server',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production'
    },
    staging: {
      user: 'ubuntu',
      host: ['your-staging-ec2-instance-ip'],
      ref: 'origin/develop',
      repo: 'your-git-repository-url',
      path: '/home/ubuntu/event-ai-server-staging',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env staging'
    }
  }
};
