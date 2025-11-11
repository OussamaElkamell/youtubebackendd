// controllers/apiProfiles.controller.js
const ApiProfile = require('../models/ApiProfile');



exports.getAllProfiles = async (req, res) => {
  try {
    const profiles = await ApiProfile.find().sort({ createdAt: -1 });
    res.json(profiles);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.getActiveProfile = async (req, res) => {
  try {
    const profile = await ApiProfile.findOne({ isActive: true });
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
    const profile = await ApiProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    res.json(profile);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ message: 'Profile not found' });
    }
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.createProfile = async (req, res) => {
  const { name, clientId, clientSecret, apiKey, redirectUri, isActive,limitQuota } = req.body;

  try {
    // If setting as active, deactivate all others first
    if (isActive) {
      await ApiProfile.updateMany({}, { $set: { isActive: false } });
    }

    const newProfile = new ApiProfile({
      name,
      clientId,
      clientSecret,
      apiKey,
      redirectUri: redirectUri || 'http://localhost:4000/accounts',
      isActive: Boolean(isActive),
      limitQuota
    });

    const profile = await newProfile.save();
    res.status(201).json(profile);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.updateProfile = async (req, res) => {
  const { name, clientId, clientSecret, apiKey, redirectUri, isActive ,limitQuota } = req.body;

  try {
    let profile = await ApiProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    // If setting as active, deactivate all others first
    if (isActive) {
      await ApiProfile.updateMany({ _id: { $ne: req.params.id } }, { $set: { isActive: false } });
    }

    profile.name = name || profile.name;
    profile.clientId = clientId || profile.clientId;
    
    // Only update clientSecret if provided
    if (clientSecret) {
      profile.clientSecret = clientSecret;
    }
    
    profile.apiKey = apiKey || profile.apiKey;
    profile.redirectUri = redirectUri || profile.redirectUri;
    profile.isActive = typeof isActive !== 'undefined' ? isActive : profile.isActive;
    profile.limitQuota=limitQuota

    await profile.save();
    res.json(profile);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ message: 'Profile not found' });
    }
    res.status(500).json({ message: 'Server Error' });
  }
};

exports.deleteProfile = async (req, res) => {
    try {
      const profile = await ApiProfile.findById(req.params.id);
      if (!profile) {
        return res.status(404).json({ message: 'Profile not found' });
      }
  
      // Prevent deleting the active profile
      if (profile.isActive) {
        return res.status(400).json({ message: 'Cannot delete active profile' });
      }
  
      // Use deleteOne instead of remove
      await ApiProfile.deleteOne({ _id: req.params.id });
  
      res.json({ message: 'Profile removed' });
    } catch (err) {
      console.error(err.message);
      if (err.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Profile not found' });
      }
      res.status(500).json({ message: 'Server Error' });
    }
  };
  

exports.setActiveProfile = async (req, res) => {
  try {
    // First deactivate all profiles
    await ApiProfile.updateMany({}, { $set: { isActive: false } });

    // Then activate the selected one
    const profile = await ApiProfile.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: true } },
      { new: true }
    );

    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    res.json(profile);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ message: 'Profile not found' });
    }
    res.status(500).json({ message: 'Server Error' });
  }
};