
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const { ProxyModel } = require('../models/proxy.model');

const router = express.Router();

/**
 * @route GET /api/proxies
 * @desc Get all proxies for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const proxies = await ProxyModel.find({ user: req.user.id });
    res.json({ proxies });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/proxies
 * @desc Create a new proxy
 * @access Private
 */
router.post('/', authenticateJWT, async (req, res, next) => {
  try {
    const { host, port, username, password, protocol, notes } = req.body;
    
    const proxy = await ProxyModel.create({
      user: req.user.id,
      host,
      port,
      username,
      password,
      protocol: protocol || 'http',
      notes,
      status: 'active'
    });
    
    res.status(201).json({ 
      message: 'Proxy created successfully',
      proxy 
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route PUT /api/proxies/:id
 * @desc Update a proxy
 * @access Private
 */
router.put('/:id', authenticateJWT, async (req, res, next) => {
  try {
    const { host, port, username, password, protocol, status, notes } = req.body;
    
    const proxy = await ProxyModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!proxy) {
      return res.status(404).json({ message: 'Proxy not found' });
    }
    
    // Update fields if provided
    if (host) proxy.host = host;
    if (port) proxy.port = port;
    if (username !== undefined) proxy.username = username;
    if (password !== undefined) proxy.password = password;
    if (protocol) proxy.protocol = protocol;
    if (status) proxy.status = status;
    if (notes !== undefined) proxy.notes = notes;
    
    await proxy.save();
    
    res.json({ 
      message: 'Proxy updated successfully',
      proxy 
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route DELETE /api/proxies/:id
 * @desc Delete a proxy
 * @access Private
 */
router.delete('/:id', authenticateJWT, async (req, res, next) => {
  try {
    const result = await ProxyModel.deleteOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Proxy not found' });
    }
    
    res.json({ message: 'Proxy deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/proxies/:id/check
 * @desc Check proxy health
 * @access Private
 */
router.post('/:id/check', authenticateJWT, async (req, res, next) => {
  try {
    const proxy = await ProxyModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!proxy) {
      return res.status(404).json({ message: 'Proxy not found' });
    }
    
    const result = await ProxyModel.checkStatus(proxy._id);
    
    res.json({
      message: result.success ? 'Proxy is working' : 'Proxy check failed',
      status: proxy.status,
      lastChecked: proxy.lastChecked,
      speed: proxy.connectionSpeed,
      result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/proxies/bulk-check
 * @desc Check multiple proxies health
 * @access Private
 */
router.post('/bulk-check', authenticateJWT, async (req, res, next) => {
  try {
    const { proxyIds } = req.body;
    
    if (!proxyIds || !Array.isArray(proxyIds)) {
      return res.status(400).json({ message: 'Invalid request. proxyIds array is required' });
    }
    
    // Check each proxy sequentially
    const results = [];
    for (const proxyId of proxyIds) {
      try {
        const proxy = await ProxyModel.findOne({
          _id: proxyId,
          user: req.user.id
        });
        
        if (!proxy) {
          results.push({
            id: proxyId,
            success: false,
            message: 'Proxy not found'
          });
          continue;
        }
        
        const checkResult = await ProxyModel.checkStatus(proxy._id);
        
        results.push({
          id: proxy._id,
          host: proxy.host,
          port: proxy.port,
          protocol: proxy.protocol,
          status: proxy.status,
          success: checkResult.success,
          speed: proxy.connectionSpeed,
          lastChecked: proxy.lastChecked
        });
      } catch (error) {
        results.push({
          id: proxyId,
          success: false,
          message: error.message
        });
      }
    }
    
    res.json({ results });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
