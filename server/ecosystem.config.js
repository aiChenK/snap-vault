module.exports = {
  apps: [
    {
      name: 'snap-vault',
      script: 'src/index.js',
      cwd: './',
      instances: 1,
      exec_mode: 'fork', // 单实例 fork 模式，确保进程内串行锁与清单原子写安全
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
