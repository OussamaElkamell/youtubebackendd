
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const { CommentModel } = require('../models/comment.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { postComment } = require('../services/youtube.service');

const router = express.Router();

/**
 * @route GET /api/comments
 * @desc Get all comments for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    
    const query = { user: req.user.id };
    
    // Filter by status if provided
    if (status) {
      query.status = status;
    }
    
    const comments = await CommentModel.find(query)
      .populate('youtubeAccount', 'email channelTitle status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
      
    const total = await CommentModel.countDocuments(query);
    
    res.json({
      comments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/comments
 * @desc Create a new comment
 * @access Private
 */
router.post('/', authenticateJWT, async (req, res, next) => {
  try {
    const { 
      youtubeAccountId, 
      videoId, 
      parentId,
      content, 
      postNow = false,
      scheduledFor
    } = req.body;
    
    // Validate YouTube account
    const account = await YouTubeAccountModel.findOne({
      _id: youtubeAccountId,
      user: req.user.id
    }).populate('proxy');
    
    if (!account) {
      return res.status(404).json({ message: 'YouTube account not found' });
    }
    
    if (account.status !== 'active') {
      return res.status(400).json({
        message: 'YouTube account is not active',
        status: account.status
      });
    }
    
    // Create comment
    const comment = new CommentModel({
      user: req.user.id,
      youtubeAccount: account._id,
      videoId,
      parentId,
      content,
      status: postNow ? 'pending' : 'scheduled',
      scheduledFor: scheduledFor || null
    });
    
    await comment.save();
    
    // Post comment immediately if requested
    if (postNow) {
      try {
        const result = await postComment(comment._id);
        
        if (result.success) {
          comment.status = 'posted';
          comment.postedAt = new Date();
          comment.commentId = result.commentId;
          await comment.save();
        } else {
          comment.status = 'failed';
          comment.errorMessage = result.error;
          comment.retryCount += 1;
          await comment.save();
          
          return res.status(400).json({
            message: 'Failed to post comment',
            error: result.error,
            comment
          });
        }
      } catch (error) {
        comment.status = 'failed';
        comment.errorMessage = error.message;
        comment.retryCount += 1;
        await comment.save();
        
        return res.status(500).json({
          message: 'Error posting comment',
          error: error.message,
          comment
        });
      }
    }
    
    res.status(201).json({
      message: postNow ? 'Comment posted successfully' : 'Comment scheduled successfully',
      comment
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/comments/:id/retry
 * @desc Retry posting a failed comment
 * @access Private
 */
router.post('/:id/retry', authenticateJWT, async (req, res, next) => {
  try {
    const comment = await CommentModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    
    if (comment.status !== 'failed') {
      return res.status(400).json({
        message: 'Only failed comments can be retried',
        status: comment.status
      });
    }
    
    // Retry posting the comment
    try {
      const result = await postComment(comment._id);
      
      if (result.success) {
        comment.status = 'posted';
        comment.postedAt = new Date();
        comment.commentId = result.commentId;
        await comment.save();
        
        res.json({
          message: 'Comment posted successfully',
          comment
        });
      } else {
        comment.status = 'failed';
        comment.errorMessage = result.error;
        comment.retryCount += 1;
        await comment.save();
        
        res.status(400).json({
          message: 'Failed to post comment',
          error: result.error,
          comment
        });
      }
    } catch (error) {
      comment.status = 'failed';
      comment.errorMessage = error.message;
      comment.retryCount += 1;
      await comment.save();
      
      res.status(500).json({
        message: 'Error posting comment',
        error: error.message,
        comment
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * @route DELETE /api/comments/:id
 * @desc Delete a comment
 * @access Private
 */
router.delete('/:id', authenticateJWT, async (req, res, next) => {
  try {
    const result = await CommentModel.deleteOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    
    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
