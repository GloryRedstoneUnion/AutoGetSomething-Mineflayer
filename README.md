# AutoGetSomething-Mineflayer
```
AutoGetSomething-Mineflayer/
├── main.js           #主代码(已弃用)
├── todo.js           #主代码(使用)
├── list.csv          #物品查询对照表
├── package.json      # npm依赖
└── README.md         # 项目说明
```
##  Features
- 我要 <物品> <数量>
  - 示例 : `我要 红石块 1`
- !!get <id> <count>
  - 示例 : `!!get redstone_block 1`
- !!todo <filename>
  - 示例 : !!todo material_list_date.txt
   
**注意 : 物品或者id可以用中译(zh_cn)也可以用英译(en_us)，物品ID也可以，`minecraft:`可带可不带**

## Install
```bash
npm install
node todo.js