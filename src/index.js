
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

// Import services
const { setupScheduler } = require('./services/scheduler.service');
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
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://youtubefront.vercel.app");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");

  // If it's a preflight request, stop here
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

// Setup Passport.js for Google OAuth
setupPassport();
app.use(passport.initialize());

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/proxies', proxiesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/scheduler', schedulerRoutes);

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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize the comment scheduler
  setupScheduler();
});

module.exports = app;
