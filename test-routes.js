const schedulerRoutes = require('./routes/scheduler.routes');
console.log('Routes in scheduler.routes.js:');
schedulerRoutes.stack.forEach(layer => {
    if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
        console.log(`${methods} ${layer.route.path}`);
    }
});
