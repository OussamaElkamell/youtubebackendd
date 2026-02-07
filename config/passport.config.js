
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const prisma = require('../services/prisma.service');

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
      let user = await prisma.user.findUnique({
        where: { googleId: profile.id }
      });

      // If user doesn't exist, create a new one
      if (!user) {
        user = await prisma.user.create({
          data: {
            name: profile.displayName,
            email: profile.emails[0].value,
            googleId: profile.id,
            googleEmail: profile.emails[0].value
          }
        });
      }

      // Check if this YouTube account is already connected
      const existingAccount = await prisma.youTubeAccount.findFirst({
        where: {
          userId: user.id,
          channelId: profile.id
        }
      });

      // If account doesn't exist, create a new one
      if (!existingAccount) {
        // Get an active API profile for the account
        const apiProfile = await prisma.apiProfile.findFirst({
          where: { isActive: true }
        });

        if (!apiProfile) {
          throw new Error('No active API profile available');
        }

        await prisma.youTubeAccount.create({
          data: {
            userId: user.id,
            status: 'active',
            email: profile.emails[0].value,
            channelId: profile.id,
            channelTitle: profile.displayName,
            thumbnailUrl: profile.photos?.[0]?.value || '',
            accessToken: accessToken,
            refreshToken: refreshToken,
            tokenExpiry: new Date(Date.now() + 3600 * 1000), // expires in 1 hour
            clientId: apiProfile.clientId,
            clientSecret: apiProfile.clientSecret,
            redirectUri: apiProfile.redirectUri,
            apiProfileId: apiProfile.id
          }
        });
      } else {
        // Update the existing account with new tokens
        await prisma.youTubeAccount.update({
          where: { id: existingAccount.id },
          data: {
            accessToken: accessToken,
            refreshToken: refreshToken,
            tokenExpiry: new Date(Date.now() + 3600 * 1000),
            status: 'active'
          }
        });
      }

      return done(null, user);
    } catch (error) {
      console.error('Error in Google OAuth strategy:', error);
      return done(error, null);
    }
  }));
};

module.exports = { setupPassport };
