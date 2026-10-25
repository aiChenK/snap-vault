#!/usr/bin/env node

const readline = require('readline');
const {
  formatBytes,
  inspectMachine,
  cleanMachineData,
  listAllMachinesWithStats,
} = require('./cleaner');
const { sanitizeMachine } = require('./files');

// 解析命令行参数
function parseArgs(argv) {
  const args = {
    machine: null,
    yes: false,
    dryRun: false,
    list: false,
    help: false,
  };

  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '-y' || arg === '--yes' || arg === '-f' || arg === '--force') {
      args.yes = true;
    } else if (arg === '-n' || arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '-l' || arg === '--list') {
      args.list = true;
    } else if (arg === '-m' || arg === '--machine') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        args.machine = argv[++i];
      } else {
        throw new Error('缺少 -m/--machine 参数值');
      }
    } else if (arg.startsWith('--machine=')) {
      args.machine = arg.slice('--machine='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!args.machine && positional.length > 0) {
    args.machine = positional[0];
  }

  return args;
}

function printHelp() {
  console.log(`
==================================================================
           SnapVault 服务端计算机清理工具 (SnapVault Clean)
==================================================================

说明:
  彻底清理指定计算机在服务端的所有图片（原图、缩略图、回收站）以及清单文件。
  清理后该计算机在 Web 画廊与机器列表中将不再显示。

用法:
  node src/clean.js [选项] [计算机名]
  npm run clean -- [选项] [计算机名]

选项:
  -m, --machine <name>   指定要清理的计算机名称
  -y, --yes, -f, --force 跳过交互确认，直接执行删除 (脚本/非TTY环境中必需)
  -n, --dry-run          试运行模式，仅展示将删除的文件和大小，不实际删除
  -l, --list             列出服务端当前存储的所有计算机及其占用统计
  -h, --help             显示此帮助信息并退出

示例:
  # 查看服务端已有计算机列表
  node src/clean.js --list

  # 试运行预览某计算机将要清理的数据
  node src/clean.js --machine desktop-pc --dry-run

  # 交互式清理某计算机 (会提示用户二次确认)
  node src/clean.js desktop-pc

  # 自动化/静默清理某计算机
  node src/clean.js -m desktop-pc -y
==================================================================
`);
}

/**
 * 终端交互确认
 */
function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = (answer || '').trim().toLowerCase();
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

async function handleList() {
  console.log('\n>>> 正在检索服务端计算机数据...');
  const machines = await listAllMachinesWithStats();

  console.log('==================================================================');
  console.log('               SnapVault 服务端计算机列表                         ');
  console.log('==================================================================');

  if (machines.length === 0) {
    console.log(' (当前服务端没有任何已注册的计算机或清单数据)');
    console.log('==================================================================\n');
    return;
  }

  machines.forEach((item, index) => {
    console.log(`[${index + 1}] 计算机名称: ${item.machine}`);
    console.log(`    - 原图 (Uploads) : ${item.uploads.count} 张 (${formatBytes(item.uploads.totalBytes)})`);
    console.log(`    - 缩略图 (Thumbs) : ${item.thumbs.count} 张 (${formatBytes(item.thumbs.totalBytes)})`);
    console.log(`    - 回收站 (Trash)  : ${item.trash.count} 张 (${formatBytes(item.trash.totalBytes)})`);
    console.log(`    - 清单 (Manifest) : ${item.manifest.exists ? `存在 (${item.manifest.itemsCount} 条记录, ${formatBytes(item.manifest.totalBytes)})` : '不存在'}`);
    console.log(`    - 累计占用空间   : ${formatBytes(item.totalBytes)} (共 ${item.totalFiles} 个文件)`);
    console.log('------------------------------------------------------------------');
  });

  console.log(`总计: ${machines.length} 台计算机\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`参数错误: ${err.message}`);
    console.log("使用 'node src/clean.js --help' 查看帮助文档。");
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.list) {
    await handleList();
    process.exit(0);
  }

  if (!args.machine) {
    console.error('错误: 请指定要清理的计算机名称。');
    printHelp();
    console.log('当前服务端已有计算机:');
    await handleList();
    process.exit(1);
  }

  // 安全清洗计算机标识
  let cleanMachine;
  try {
    cleanMachine = sanitizeMachine(args.machine);
  } catch (err) {
    console.error(`错误: 计算机名称非法: ${err.message}`);
    process.exit(1);
  }

  // 检查计算机现有数据统计
  const stats = await inspectMachine(cleanMachine);

  if (!stats.exists) {
    console.log(`\n⚠️  未在服务端检测到计算机 "${cleanMachine}" 的任何图片或清单数据。无需清理。`);
    process.exit(0);
  }

  console.log('\n==================================================================');
  console.log(`           SnapVault 计算机数据清理: ${cleanMachine}               `);
  console.log('==================================================================');
  console.log(` 计算机标识   : ${cleanMachine}`);
  console.log(` 运行模式     : ${args.dryRun ? '【试运行预览 (Dry-Run)】(不实际删除文件)' : '【正式删除执行】'}`);
  console.log('------------------------------------------------------------------');
  console.log(` - 原图文件   : ${stats.uploads.count} 个 (${formatBytes(stats.uploads.totalBytes)}) -> ${stats.uploads.path}`);
  console.log(` - 缩略图文件 : ${stats.thumbs.count} 个 (${formatBytes(stats.thumbs.totalBytes)}) -> ${stats.thumbs.path}`);
  console.log(` - 回收站文件 : ${stats.trash.count} 个 (${formatBytes(stats.trash.totalBytes)}) -> ${stats.trash.path}`);
  console.log(` - 清单文件   : ${stats.manifest.exists ? `存在 (${stats.manifest.itemsCount} 条记录, ${formatBytes(stats.manifest.totalBytes)})` : '无清单'} -> ${stats.manifest.path}`);
  console.log('------------------------------------------------------------------');
  console.log(` 预计释放空间 : ${formatBytes(stats.totalBytes)} (共 ${stats.totalFiles} 个文件)`);
  console.log('==================================================================');

  if (args.dryRun) {
    console.log('\n✓ 试运行完成。未删除任何文件。若要执行实际删除，请去掉 --dry-run 参数。\n');
    process.exit(0);
  }

  // 确认逻辑
  if (!args.yes) {
    const isTTY = Boolean(process.stdin.isTTY);
    if (!isTTY) {
      console.error('\n错误: 在非交互终端中执行清理时，必须显式附加 -y 或 --yes 参数确认。');
      process.exit(1);
    }

    console.log('\n⚠️  警告: 此操作将永久删除该计算机下的所有原图、缩略图、回收站文件及清单数据，不可逆！');
    const confirmed = await askConfirmation(`确认彻底清理计算机 "${cleanMachine}" 的所有数据吗？(y/N): `);
    if (!confirmed) {
      console.log('已取消操作，未做任何修改。\n');
      process.exit(0);
    }
  }

  console.log('\n>>> 正在执行安全清理...');
  const result = await cleanMachineData(cleanMachine, { dryRun: false });

  console.log('\n==================================================================');
  console.log('                       清理完成报告                               ');
  console.log('==================================================================');
  if (result.uploads.exists) console.log(`  ✓ 已删除原图目录   : uploads/${cleanMachine}/ (${result.uploads.count} 个文件)`);
  if (result.thumbs.exists)  console.log(`  ✓ 已删除缩略图目录 : thumbs/${cleanMachine}/ (${result.thumbs.count} 个文件)`);
  if (result.trash.exists)   console.log(`  ✓ 已删除回收站目录 : trash/${cleanMachine}/ (${result.trash.count} 个文件)`);
  if (result.manifest.exists)console.log(`  ✓ 已删除清单文件   : manifests/${cleanMachine}.json`);
  console.log('------------------------------------------------------------------');
  console.log(`🎉 计算机 "${cleanMachine}" 已彻底清理完毕！共释放磁盘空间 ${formatBytes(result.totalBytes)}。`);
  console.log('==================================================================\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n清理过程发生异常:', err.message);
    process.exit(1);
  });
}
