module.exports = { apps: [{ name:'boostbot', script:'npm', args:'start', env:{ NODE_ENV:'production' }, watch:false, max_restarts:10, autorestart:true }] };
