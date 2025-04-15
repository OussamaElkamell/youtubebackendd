async function processImmediateComments() {
    console.log('Running immediate comment processor...');
  // Run every minute
  const job = cron.schedule('* * * * *', async () => {
    try {
      // Find pending comments scheduled for immediate posting
      const pendingComments = await CommentModel.find({
        status: 'pending',
        scheduledFor: null
      }).limit(10);
      
      // Process each comment
      for (const comment of pendingComments) {
        try {
          await postComment(comment._id);
        } catch (error) {
          console.error(`Error posting immediate comment ${comment._id}:`, error);
        }
      }
    } catch (error) {
      console.error('Error processing immediate comments:', error);
    }
  });
  
  activeJobs.set('immediate-processor', job);
  }
  
  module.exports = { processImmediateComments };
  