# AutoGetSomething-Mineflayer

一个基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 机器人,
用于在服务器中自动获取/取回指定物品。

## 项目结构

```
AutoGetSomething-Mineflayer/
├── todo.js           # 主代码(当前使用)
├── mathEvaluator.js  # 数学表达式求值工具(!!do使用)
├── list.csv          # 物品查询对照表(中英译名 → 物品 ID)
├── package.json      # npm 依赖
└── README.md         # 项目说明
```

## 功能

机器人在游戏中识别玩家聊天消息并执行对应操作。

### 1. 获取单个物品

#### `!!get <id> <count>`
按 Minecraft 物品 ID 获取指定数量的物品。

- 示例:`!!get redstone_block 1`

#### `我要 <物品> <数量>`
使用自然语言(支持中文 / 英文物品名)获取指定数量的物品。

- 示例:`我要 红石块 1`
- 示例:`我要 redstone_block 1`

> **注意**:物品或者 id 可以用中译(`zh_cn`)也可以用英译(`en_us`),物品 ID 也可以;`minecraft:` 前缀可带可不带。

### 2. 批量获取(投影列表)

#### `!!todo <filename>`
读取 `<filename>` 中列出的投影物品清单,按顺序批量取回,完成后在聊天中报告缺失项。

> 清单文件需放在 bot 进程可访问的目录中,文件名需带txt后缀。

### 3. 其它

- 控制台输入会通过 `bot.chat` 直接转发到游戏内聊天。
- 机器人启动后自动 `/login abc123456` 完成登录。
- 启动完成后自动 `/server Survival` 切换到生存服。

## 安装与运行

```bash
# 安装依赖
npm install

# 启动机器人
node todo.js
```

> 启动前请确认 `todo.js` 中的服务器配置(`host` / `port` / `username` / `version`)与目标服务器匹配。

## 物品对照表

`list.csv` 是 `zh_cn` / `en_us` 物品名到 Minecraft 物品 ID 的映射表,
由 `todo.js` 在启动时加载。**修改后需重启机器人生效。**

## 配置说明

`todo.js` 顶部的 bot 配置:

| 字段      | 说明                                | 默认值                       |
| --------- | ----------------------------------- | ---------------------------- |
| `host`    | Minecraft 服务器地址                | `inbound.grunion.world`      |
| `port`    | 服务器端口                          | `30000`                      |
| `username`| 机器人游戏内昵称                    | `Chat`                       |
| `version` | 目标服务器 Minecraft 版本           | `1.20.1`                     |

## 依赖

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 客户端框架
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 寻路插件
- [csv-parse](https://www.npmjs.com/package/csv-parse) / [csv-parser](https://www.npmjs.com/package/csv-parser) — 解析 `list.csv`
- [iconv-lite](https://www.npmjs.com/package/iconv-lite) / [chardet](https://www.npmjs.com/package/chardet) — 编码处理
- `chatbot-agent`(本地 `file:../chatbot`)— 集成的对话 agent(已注释,默认未启用)

## License

This project is licensed under the CC BY-NC 4.0 License.

You are free to:
- Use this project
- Modify this project
- Share this project

Under the conditions:
- Attribution is required
- Commercial use is prohibited