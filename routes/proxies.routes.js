
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const prisma = require('../services/prisma.service');
const { checkProxyStatus } = require('../services/proxy.helper');

const router = express.Router();

/**
 * @route GET /api/proxies
 * @desc Get all proxies for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const proxies = await prisma.proxy.findMany({
      where: { userId: req.user.id }
    });
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
    console.log('Creating proxy:', { host, port, protocol });

    const proxy = await prisma.proxy.create({
      data: {
        userId: req.user.id,
        proxy: `${host}:${port}${username ? `:${username}` : ''}${password ? `:${password}` : ''}`,
        host,
        port: parseInt(port),
        username,
        password,
        protocol: protocol || 'http',
        notes,
        status: 'active'
      }
    });
    console.log('Proxy created:', proxy.id);

    res.status(201).json({
      message: 'Proxy created successfully',
      proxy
    });
  } catch (error) {
    console.error('Error creating proxy:', error);
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
    console.log('Updating proxy ID:', req.params.id, 'Data:', req.body);

    const proxy = await prisma.proxy.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!proxy) {
      console.warn('Proxy not found for update:', req.params.id);
      return res.status(404).json({ message: 'Proxy not found' });
    }

    const updateData = {};
    if (host) updateData.host = host;
    if (port) updateData.port = parseInt(port);
    if (username !== undefined) updateData.username = username;
    if (password !== undefined) updateData.password = password;
    if (protocol) updateData.protocol = protocol;
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    // Update the 'proxy' string field if host or port or creds changed
    if (host || port || username !== undefined || password !== undefined) {
      const h = host || proxy.host;
      const p = port || proxy.port;
      const u = username !== undefined ? username : proxy.username;
      const pass = password !== undefined ? password : proxy.password;
      updateData.proxy = `${h}:${p}${u ? `:${u}` : ''}${pass ? `:${pass}` : ''}`;
    }

    const updatedProxy = await prisma.proxy.update({
      where: { id: req.params.id },
      data: updateData
    });
    console.log('Proxy updated successfully:', updatedProxy.id);

    res.json({
      message: 'Proxy updated successfully',
      proxy: updatedProxy
    });
  } catch (error) {
    console.error('Error updating proxy:', error);
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
    const proxy = await prisma.proxy.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!proxy) {
      return res.status(404).json({ message: 'Proxy not found' });
    }

    await prisma.proxy.delete({
      where: { id: req.params.id }
    });

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
    const proxy = await prisma.proxy.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!proxy) {
      return res.status(404).json({ message: 'Proxy not found' });
    }

    const result = await checkProxyStatus(proxy.id);

    const updatedProxy = await prisma.proxy.findUnique({
      where: { id: proxy.id }
    });

    res.json({
      message: result.success ? 'Proxy is working' : 'Proxy check failed',
      status: updatedProxy.status,
      lastChecked: updatedProxy.lastChecked,
      speed: updatedProxy.connectionSpeed,
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

    const results = [];
    for (const proxyId of proxyIds) {
      try {
        const proxy = await prisma.proxy.findFirst({
          where: {
            id: proxyId,
            userId: req.user.id
          }
        });

        if (!proxy) {
          results.push({
            id: proxyId,
            success: false,
            message: 'Proxy not found'
          });
          continue;
        }

        const checkResult = await checkProxyStatus(proxy.id);

        const updatedProxy = await prisma.proxy.findUnique({
          where: { id: proxy.id }
        });

        results.push({
          id: updatedProxy.id,
          host: updatedProxy.host,
          port: updatedProxy.port,
          protocol: updatedProxy.protocol,
          status: updatedProxy.status,
          success: checkResult.success,
          speed: updatedProxy.connectionSpeed,
          lastChecked: updatedProxy.lastChecked
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
