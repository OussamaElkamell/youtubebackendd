
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { UserModel } = require('../models/user.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');

/**
 * Sets up Passport.js with Google OAuth strategy
 */
const setupPassport = () => {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_REDIRECT_URI,
    scope: [
      'profile', 
      'email',
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ]
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      // Check if user exists in our database
      let user = await UserModel.findOne({ 'google.id': profile.id });
      
      // If user doesn't exist, create a new one
      if (!user) {
        user = await UserModel.create({
          name: profile.displayName,
          email: profile.emails[0].value,
          google: {
            id: profile.id,
            email: profile.emails[0].value
          }
        });
      }
      
      // Check if this YouTube account is already connected
      const existingAccount = await YouTubeAccountModel.findOne({
        user: user._id,
        'google.id': profile.id
      });
      
      // If account doesn't exist, create a new one
      if (!existingAccount) {
        const youtubeAccount = await YouTubeAccountModel.create({
          user: user._id,
          status: 'active',
          email: profile.emails[0].value,
          channelId: profile.id,
          channelTitle: profile.displayName,
          thumbnailUrl: profile.photos?.[0]?.value || '',
          google: {
            id: profile.id,
            accessToken,
            refreshToken,
            tokenExpiry: new Date(Date.now() + 3600 * 1000) // expires in 1 hour
          }
        });

        // Add account reference to user
        user.youtubeAccounts.push(youtubeAccount._id);
        await user.save();
      } else {
        // Update the existing account with new tokens
        existingAccount.google.accessToken = accessToken;
        existingAccount.google.refreshToken = refreshToken;
        existingAccount.google.tokenExpiry = new Date(Date.now() + 3600 * 1000);
        existingAccount.status = 'active';
        await existingAccount.save();
      }
      
      return done(null, user);
    } catch (error) {
      console.error('Error in Google OAuth strategy:', error);
      return done(error, null);
    }
  }));
};

module.exports = { setupPassport };
