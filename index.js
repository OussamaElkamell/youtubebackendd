
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const passport = require('passport');

// Import route handlers
const authRoutes = require('./routes/auth.routes');
const accountsRoutes = require('./routes/accounts.routes');
const proxiesRoutes = require('./routes/proxies.routes');
const commentsRoutes = require('./routes/comments.routes');
const schedulerRoutes = require('./routes/scheduler.routes');
const apiProfilesRoutes = require('./routes/apiProfiles.routes');
require('./cron/resetQuota');
// Import services
const { setupScheduler, shutdown, scheduleQuotaReset, scheduleFrequentStatusReset, setupMaintenanceJob, resetRedis } = require('./services/scheduler.service');
const { setupPassport } = require('./config/passport.config');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 4000;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});
// Configure middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:4000',
  credentials: true
}));
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000000000000, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

setupPassport();
app.use(passport.initialize());

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/proxies', proxiesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/profiles', apiProfilesRoutes);
// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// Error handler middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message,
      status: err.status || 500
    }
  });
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize the comment scheduler
  setupScheduler();
  scheduleQuotaReset();

  // scheduleFrequentStatusReset()
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await shutdown();
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await shutdown();
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});

module.exports = app;