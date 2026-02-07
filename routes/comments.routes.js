
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const prisma = require('../services/prisma.service');
const { postComment } = require('../services/youtube.service');

const router = express.Router();

/**
 * @route GET /api/comments
 * @desc Get all comments for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 100000 } = req.query;

    const where = { userId: req.user.id };

    // Filter by status if provided
    if (status) {
      where.status = status;
    }

    // Get the current date and calculate the date for 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Fetch the comments based on the query with pagination
    const comments = await prisma.comment.findMany({
      where,
      include: {
        youtubeAccount: {
          select: {
            email: true,
            channelTitle: true,
            status: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    // Get the total number of comments before pagination
    const total = await prisma.comment.count({ where });

    // Get the total number of comments with status 'posted' in the last 7 days
    const totalPostedLast7Days = await prisma.comment.count({
      where: {
        ...where,
        status: 'posted',
        createdAt: { gte: sevenDaysAgo }
      }
    });

    // Send the response with both total comments and total posted comments in the last 7 days
    res.json({
      comments,
      pagination: {
        total,
        totalPostedLast7Days,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
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
    const account = await prisma.youTubeAccount.findFirst({
      where: {
        id: youtubeAccountId,
        userId: req.user.id
      },
      include: { proxy: true }
    });

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
    const comment = await prisma.comment.create({
      data: {
        userId: req.user.id,
        youtubeAccountId: account.id,
        videoId,
        parentId,
        content,
        status: postNow ? 'pending' : 'scheduled',
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null
      }
    });

    // Post comment immediately if requested
    if (postNow) {
      try {
        const result = await postComment(comment.id);

        if (result.success) {
          const updatedComment = await prisma.comment.update({
            where: { id: comment.id },
            data: {
              status: 'posted',
              postedAt: new Date(),
              commentId: result.commentId
            }
          });

          return res.status(201).json({
            message: 'Comment posted successfully',
            comment: updatedComment
          });
        } else {
          const updatedComment = await prisma.comment.update({
            where: { id: comment.id },
            data: {
              status: 'failed',
              errorMessage: result.error,
              retryCount: { increment: 1 }
            }
          });

          return res.status(400).json({
            message: 'Failed to post comment',
            error: result.error,
            comment: updatedComment
          });
        }
      } catch (error) {
        const updatedComment = await prisma.comment.update({
          where: { id: comment.id },
          data: {
            status: 'failed',
            errorMessage: error.message,
            retryCount: { increment: 1 }
          }
        });

        return res.status(500).json({
          message: 'Error posting comment',
          error: error.message,
          comment: updatedComment
        });
      }
    }

    res.status(201).json({
      message: 'Comment scheduled successfully',
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
    const comment = await prisma.comment.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
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
      const result = await postComment(comment.id);

      if (result.success) {
        const updatedComment = await prisma.comment.update({
          where: { id: comment.id },
          data: {
            status: 'posted',
            postedAt: new Date(),
            commentId: result.commentId
          }
        });

        return res.json({
          message: 'Comment posted successfully',
          comment: updatedComment
        });
      } else {
        const updatedComment = await prisma.comment.update({
          where: { id: comment.id },
          data: {
            status: 'failed',
            errorMessage: result.error,
            retryCount: { increment: 1 }
          }
        });

        return res.status(400).json({
          message: 'Failed to post comment',
          error: result.error,
          comment: updatedComment
        });
      }
    } catch (error) {
      const updatedComment = await prisma.comment.update({
        where: { id: comment.id },
        data: {
          status: 'failed',
          errorMessage: error.message,
          retryCount: { increment: 1 }
        }
      });

      return res.status(500).json({
        message: 'Error posting comment',
        error: error.message,
        comment: updatedComment
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
    const comment = await prisma.comment.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    await prisma.comment.delete({
      where: { id: req.params.id }
    });

    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route DELETE /api/comments
 * @desc Delete all 'posted' comments for the authenticated user
 * @access Private
 */
router.delete('/', authenticateJWT, async (req, res, next) => {
  try {
    const result = await prisma.comment.deleteMany({
      where: {
        userId: req.user.id,
        status: 'posted'
      }
    });

    if (result.count === 0) {
      return res.status(404).json({ message: 'No posted comments to delete' });
    }

    res.json({ message: 'All posted comments deleted successfully', count: result.count });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
