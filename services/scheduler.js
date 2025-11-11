const { commentQueue } = require('../queues/queue');
const ScheduleModel = require('../models/ScheduleModel');

async function processSchedule(scheduleId) {
  const schedule = await ScheduleModel.findById(scheduleId);
  if (!schedule || schedule.status !== 'active') return;

  const { accounts, comments, intervalInSeconds } = schedule;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    for (let j = 0; j < comments.length; j++) {
      const comment = comments[j];

      const delay = ((i * comments.length) + j) * intervalInSeconds * 1000;

      await commentQueue.add('processComment', {
        scheduleId,
        account,
        comment
      }, {
        delay,
        removeOnComplete: true,
        removeOnFail: true
      });
    }
  }
}

module.exports = { processSchedule };
