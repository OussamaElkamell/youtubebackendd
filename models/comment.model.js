
const mongoose = require('mongoose');

const CommentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  youtubeAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'YouTubeAccount',
    required: true
  },
  videoId: {
    type: String,
    required: true
  },
  parentId: String, // For replies to comments (null for top-level comments)
  content: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'posted', 'failed', 'scheduled'],
    default: 'pending'
  },
  scheduledFor: Date, // When the comment is scheduled to be posted
  postedAt: Date, // When the comment was actually posted
  errorMessage: String,
  retryCount: {
    type: Number,
    default: 0
  },
  commentId: String, // YouTube's ID for the posted comment
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const CommentModel = mongoose.model('Comment', CommentSchema);

module.exports = { CommentModel };
