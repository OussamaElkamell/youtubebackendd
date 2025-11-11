async function runMaintenance() {
    console.log('Running maintenance...');
    const job = cron.schedule('0 0 * * *', async () => {
        try {
          console.log('Running daily maintenance tasks');
          
          // Reset daily usage counters
          await YouTubeAccountModel.updateMany(
            {},
            {
              $set: {
                'dailyUsage.date': new Date(),
                'dailyUsage.commentCount': 0,
                'dailyUsage.likeCount': 0
              }
            }
          );
          
          // Complete any schedules that have ended
          const expiredSchedules = await ScheduleModel.find({
            status: 'active',
            'schedule.endDate': { $lt: new Date() }
          });
          
          for (const schedule of expiredSchedules) {
            schedule.status = 'completed';
            await schedule.save();
            
            // Stop the job
            if (activeJobs.has(schedule._id.toString())) {
              activeJobs.get(schedule._id.toString()).stop();
              activeJobs.delete(schedule._id.toString());
            }
          }
          
          console.log('Daily maintenance completed');
        } catch (error) {
          console.error('Error during daily maintenance:', error);
        }
      });
      
      activeJobs.set('maintenance', job);
  }
  
  module.exports = { runMaintenance };
  