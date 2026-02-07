// controllers/apiProfiles.controller.js
const prisma = require('../services/prisma.service');

exports.getAllProfiles = async (req, res) => {
  try {
    const profiles = await prisma.apiProfile.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json({ profiles });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.getActiveProfile = async (req, res) => {
  try {
    const profile = await prisma.apiProfile.findFirst({
      where: { isActive: true }
    });
    if (!profile) {
      return res.status(404).json({ message: 'No active profile found' });
    }
    res.json(profile);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.getProfileById = async (req, res) => {
  try {
    const profile = await prisma.apiProfile.findUnique({
      where: { id: req.params.id }
    });
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    res.json(profile);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.createProfile = async (req, res) => {
  const { name, clientId, clientSecret, apiKey, redirectUri, isActive, limitQuota } = req.body;

  try {
    // If setting as active, deactivate all others first
    if (isActive) {
      await prisma.apiProfile.updateMany({
        data: { isActive: false }
      });
    }

    const profile = await prisma.apiProfile.create({
      data: {
        name,
        clientId,
        clientSecret,
        apiKey,
        redirectUri: redirectUri || 'http://localhost:4000/accounts',
        isActive: Boolean(isActive),
        limitQuota: limitQuota || 10000
      }
    });

    res.status(201).json(profile);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.updateProfile = async (req, res) => {
  const { name, clientId, clientSecret, apiKey, redirectUri, isActive, limitQuota } = req.body;

  try {
    let profile = await prisma.apiProfile.findUnique({
      where: { id: req.params.id }
    });
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    // If setting as active, deactivate all others first
    if (isActive) {
      await prisma.apiProfile.updateMany({
        where: { id: { not: req.params.id } },
        data: { isActive: false }
      });
    }

    const updatedProfile = await prisma.apiProfile.update({
      where: { id: req.params.id },
      data: {
        name: name || profile.name,
        clientId: clientId || profile.clientId,
        clientSecret: clientSecret || profile.clientSecret,
        apiKey: apiKey || profile.apiKey,
        redirectUri: redirectUri || profile.redirectUri,
        isActive: typeof isActive !== 'undefined' ? isActive : profile.isActive,
        limitQuota: limitQuota || profile.limitQuota
      }
    });

    res.json(updatedProfile);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.deleteProfile = async (req, res) => {
  try {
    const profile = await prisma.apiProfile.findUnique({
      where: { id: req.params.id }
    });
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    // Prevent deleting the active profile
    if (profile.isActive) {
      return res.status(400).json({ message: 'Cannot delete active profile' });
    }

    await prisma.apiProfile.delete({
      where: { id: req.params.id }
    });

    res.json({ message: 'Profile removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.setActiveProfile = async (req, res) => {
  try {
    // Use a transaction to deactivate all and activate the target
    const [_, profile] = await prisma.$transaction([
      prisma.apiProfile.updateMany({
        data: { isActive: false }
      }),
      prisma.apiProfile.update({
        where: { id: req.params.id },
        data: { isActive: true }
      })
    ]);

    res.json(profile);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};
