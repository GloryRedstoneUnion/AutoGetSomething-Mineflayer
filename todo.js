const mineflayer = require('mineflayer')
const readline = require('readline');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalBlock } = goals
const fs = require('fs')
const { parse } = require('csv-parse/sync')
const data = fs.readFileSync('list.csv', 'utf8')
const iconv = require('iconv-lite');
const chardet = require('chardet');
// const { createAgent, defaultMcpExtras } = require("chatbot-agent");

// // bot 项目不在 f:\chatbot,硬指定 MCP 路径
// process.env.MC_CODE_MCP_DIR = "F:\\chatbot\\mc-code-mcp";
// process.env.MC_INDEX_DIR = "F:\\chatbot\\mc-index";


const records = parse(data, {
  columns: true,
  skip_empty_lines: true
})

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ""   // 提示符
})

const bot = mineflayer.createBot({
  host: 'inbound.grunion.world',
  port: 30000,
  username: 'Chat',
  version: '1.20.1'
})

rl.prompt()
rl.on('line', (line) => {
    const input = line.trim()
    bot.chat(input)
    rl.prompt()
})

bot.loadPlugin(pathfinder)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const { Vec3 } = require('vec3')
function pos(x,y,z)
{
    return new Vec3(x, y, z)
}
function pos2str(pos){
    return `${pos.x},${pos.y},${pos.z}`
}
function framefacting(pos1,x,y,z)
{
    switch (pos1.floor)
    {
        case 1:
            return pos(x,y+1,z);
        case 2:
        {
            if(pos1.faceOffset.z>-1432)
                return pos(x,y,z-1);
            else
                return pos(x,y,z+1);
         }
        case 3:
        {
            if(pos1.faceOffset.z>-1432)
                return pos(x,y,z-1);
            else
                return pos(x,y,z+1);
        }
        case 4:
           return pos(x,y-1,z);
    }
}
function Dzframefacting(pos1,x,y,z)
{
    if(pos1.faceOffset.x==782)
        return pos(x-1,y+2,z)
    return pos(x+1,y+2,z)
}
function waitForContainerOpen()
{
    return new Promise(resolve => {
        bot.once('windowOpen', (window) => {
        resolve(window)
    })})
}
function HasFreeSlot()
{
    for(let i=54;i<=89;i++)
    {
        if(bot.currentWindow.slots[i]==null || bot.currentWindow.slots[i]==undefined || bot.currentWindow.slots[i].name=="air")
        {
            return true
        }
    }
    return false
}

bot.once("login",() => {
    setTimeout(() => {
        bot.chat("/login abc123456")
    }, 1000);
})
bot.on('death', () => {
    console.log('[BOT] 死亡，准备重生...')
    bot.chat("操你妈")
    bot.respawn()
})

const EastScanPos = [
    { startPos: pos(790,75,-1430), faceOffset: {y:74,z:-1428}, floor: 1 },
    { startPos: pos(790,76,-1427), faceOffset: {y:77,z:-1427}, floor: 2},
    { startPos: pos(790,79,-1427), faceOffset: {y:80,z:-1427}, floor: 3 },
    { startPos: pos(790,83,-1431), faceOffset: {y:82,z:-1429}, floor: 4 },
    { startPos: pos(790,75,-1434), faceOffset: {y:74,z:-1436}, floor: 1 },
    { startPos: pos(790,76,-1437), faceOffset: {y:77,z:-1437}, floor: 2 },
    { startPos: pos(790,79,-1437), faceOffset: {y:80,z:-1437}, floor: 3 },
    { startPos: pos(790,83,-1433), faceOffset: {y:82,z:-1435}, floor: 4 },
]
const WestScanPos = [
    { startPos: pos(764,75,-1434), faceOffset: {y:74,z:-1436}, floor: 1 },
    { startPos: pos(764,76,-1437), faceOffset: {y:77,z:-1437}, floor: 2},
    { startPos: pos(764,79,-1437), faceOffset: {y:80,z:-1437}, floor: 3 },
    { startPos: pos(764,83,-1433), faceOffset: {y:82,z:-1435}, floor: 4 },
    { startPos: pos(764,75,-1430), faceOffset: {y:74,z:-1428}, floor: 1 },
    { startPos: pos(764,76,-1427), faceOffset: {y:77,z:-1427}, floor: 2 },
    { startPos: pos(764,79,-1427), faceOffset: {y:80,z:-1427}, floor: 3 },
    { startPos: pos(764,83,-1431), faceOffset: {y:82,z:-1429}, floor: 4 },
]
DzEastScanPos={ startPos: pos(782,77,-1464), faceOffset: {x:782,y:78}, floor: 1 }
DzWestscanPos={ startPos: pos(772,77,-1464), faceOffset: {x:772,y:78}, floor: 1 }

blocks = new Map()
itemFrameMap = new Map()
Dzblocks = new Map()

function beginning()
{
    let facing=1
            
    Object.values(bot.entities).filter(e => e.name === 'item_frame').forEach(entity => {
        let pos = entity.position
        let item = entity.metadata[8]
        if (entity.metadata?.[8] && !itemFrameMap.has(bot.registry.items[item.itemId].name) && bot.registry.items[item.itemId].name!="air") {
            itemFrameMap.set(pos2str(pos),bot.registry.items[item.itemId].name)
        }
    })
    wall=853
    function EastscanRow(pos)
    {
        x=pos.startPos.x
        y=pos.startPos.y
        z=pos.startPos.z
        while(x<=wall)
        {
            if(itemFrameMap.has(pos2str(framefacting(pos,x,y,z))))
            {
                blocks.set(itemFrameMap.get(pos2str(framefacting(pos,x,y,z))),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)});
            }
            else if(bot.blockAt(framefacting(pos,x,y,z)).name!="air")
            {
                if(!blocks.has(bot.blockAt(framefacting(pos,x,y,z)).name))
                {
                    if(bot.blockAt(framefacting(pos,x,y,z)).name.includes("wall_"))
                        blocks.set(bot.blockAt(framefacting(pos,x,y,z)).name.replace("wall_",""),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                    else
                        blocks.set(bot.blockAt(framefacting(pos,x,y,z)).name.replace("_wire","").replace("potted_",""),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                }
            }
            else if(bot.blockAt(new Vec3(x,y,z)).name!="air")
            {
                if(!blocks.has(bot.blockAt(new Vec3(x,y,z)).name))
                {
                    blocks.set(bot.blockAt(new Vec3(x,y,z)).name.replace("potted_",""),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                }
            }
            x+=facing;
        }
    }
    EastScanPos.forEach(pos => {
        EastscanRow(pos)
    })
    
    facing=-1
    wall=701
    function WestscanRow(pos)
    {
        x=pos.startPos.x
        y=pos.startPos.y
        z=pos.startPos.z
        while(x>=wall)
        {
            if(itemFrameMap.has(pos2str(framefacting(pos,x,y,z))))
            {
                blocks.set(itemFrameMap.get(pos2str(framefacting(pos,x,y,z))),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)});
            }
            else if(bot.blockAt(framefacting(pos,x,y,z)).name!="air")
            {
                if(!blocks.has(bot.blockAt(framefacting(pos,x,y,z)).name))
                {
                    if(bot.blockAt(framefacting(pos,x,y,z)).name.includes("wall_"))
                        blocks.set(bot.blockAt(framefacting(pos,x,y,z)).name.replace("wall_",""),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                    else
                        blocks.set(bot.blockAt(framefacting(pos,x,y,z)).name.replace("_wire","").replace("potted_",""),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                }
            }
            else if(bot.blockAt(new Vec3(x,y,z)).name!="air")
            {
                if(!blocks.has(bot.blockAt(new Vec3(x,y,z)).name))
                {
                    blocks.set(bot.blockAt(new Vec3(x,y,z)).name.replace("potted_",""),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                }
            }
            x+=facing;
        }
    }
    WestScanPos.forEach(pos => {
        WestscanRow(pos)
    })
    
    wall=-1517
    function DzScanRow(pos)
    {
        let x,y,z
        [x,y,z]=[pos.startPos.x,pos.startPos.y,pos.startPos.z]
        while(z>=wall)
        {
            if(itemFrameMap.has(pos2str(Dzframefacting(pos,x,y,z))))
            {
                if(itemFrameMap.get(pos2str(Dzframefacting(pos,x,y,z)))!="air")
                    Dzblocks.set(itemFrameMap.get(pos2str(Dzframefacting(pos,x,y,z))),{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)});
            }
            else if(bot.blockAt(new Vec3(x,y,z)).name!="air")
            {
                if(!Dzblocks.has(bot.blockAt(new Vec3(x,y,z)).name))
                {
                    Dzblocks.set(bot.blockAt(new Vec3(x,y,z)).name,{dx:x,dy:y,dz:z,df:(pos.floor),fo:(pos.faceOffset)})
                }
            }
            z--;
        }
    }
    DzScanRow(DzEastScanPos)
    DzScanRow(DzWestscanPos)
}

let busy = false
let busytodo = false
//msg消息，pr是system或chat
bot.on("message",async (msg,pr)=> {
    msg=msg.toString()
    console.log(msg)
    let match = msg.match(/^<([^>]+)>\s+!!get\s+(.+?)\s+(\d+)/i);
    if(!match)
    {
        match = msg.match(/^<([^>]+)>\s*我要\s+(.+?)\s+(\d+)\s*$/);
    }
    if (!match)
    {
        if(msg.includes("!!get") && msg.match(/^<([^>]+)>.*!!get/i) && msg.match(/^<([^>]+)>.*!!get/i)[1]!="Chat")
        {
            bot.chat("用法:!!get <id> <count>  请重试")
        }
        return 
    }

    if(busy || busytodo)
    {
        bot.chat("正在运行，请稍后重试")
        return
    }
    busy=true

    beginning()
    try
    {
        let player = match[1];
        let id = match[2];
        let count = parseInt(match[3]);
        let hasbot=0
        Object.keys(bot.players).forEach(player => {
            if(player=="bot_item")
            {
                hasbot=1
            }
        });
        if(!hasbot)
        {
            bot.chat("这得先有个bot_item假人，先生")
            bot.chat("@@ "+player)
            return 
        }
        had=0
        async function main(ItemInfo,Counts)
        {
            if(!blocks.has(ItemInfo.name) && !Dzblocks.has(ItemInfo.name))
            {
                console.log(ItemInfo.name)
                bot.chat("全物品没有或者以实体形式存在")
                bot.chat("@@ "+player)
                had=1
                return ;
            }
            function moveTo(x,y,z)//记得await
            {
                const movements = new Movements(bot)
                movements.canDig = false
                movements.allow1by1towers = false
                bot.pathfinder.setMovements(movements)
                return new Promise((resolve) => {
                    const target = new Vec3(x, y, z)
                    const current = bot.entity.position
                    if (current.distanceTo(target) < 1.2) {
                        resolve()
                        return
                    }
                    function onReach() {
                        bot.removeListener('goal_reached', onReach)
                        resolve()
                    }
                    bot.once('goal_reached', onReach)
                    bot.pathfinder.setGoal(new GoalBlock(x, y, z))
                })
            }
            count=Counts
            async function getsome(dz)
            {
                if(!dz && ((count<1728 && blocks.has(ItemInfo.name) && Dzblocks.has(ItemInfo.name)) || (blocks.has(ItemInfo.name) && !Dzblocks.has(ItemInfo.name))))
                {
                    let pos=blocks.get(ItemInfo.name)
                    await moveTo(pos.dx,77,-1432)
                    bot.activateBlock(bot.blockAt(new Vec3(pos.dx,pos.fo.y,pos.fo.z)))
                }
                else
                {
                    dz=1
                    let pos=Dzblocks.get(ItemInfo.name)
                    await moveTo(777,77,pos.dz)
                    bot.activateBlock(bot.blockAt(new Vec3(pos.fo.x,pos.fo.y,pos.dz)))
                }
                const window=await waitForContainerOpen()
                let slot=0;
                let sum=0;
                let slotiteminfo=[]
                let slotshulkerinfo=[]
                itemsum=0
                hasshulker=0
                window.slots.forEach(items => {
                    if(items && items.name.includes("shulker_box"))
                    {
                        hasshulker=1
                        slotshulkerinfo.push({first:items,second:items.slot})
                    }
                    //console.log(items.nbt.value.BlockEntityTag.value.Items.value.value)
                    else if(items)
                    {
                        slotiteminfo.push({first:items,second:items.slot})
                        itemsum+=items.count
                    }
                });
                // console.log(slotshulkerinfo)
                // console.log(slotiteminfo)
                slotiteminfo.sort((x, y) => {
                    if(y.first.count!=x.first.count)
                        return y.first.count-x.first.count;
                    return x.second-y.second
                });
                if(hasshulker)
                {
                    slotshulkerinfo.sort((x,y) => {
                        if(y.first.nbt?.value?.BlockEntityTag?.value?.Items?.value?.value && x.first.nbt?.value?.BlockEntityTag?.value?.Items?.value?.value && x.first.nbt.value.BlockEntityTag.value.Items.value.value.length!=y.first.nbt.value.BlockEntityTag.value.Items.value.value.length)
                            return y.first.nbt.value.BlockEntityTag.value.Items.value.value.length-x.first.nbt.value.BlockEntityTag.value.Items.value.value.length
                        return x.second-y.second
                    });
                }
                if((count>64 || itemsum<count) && hasshulker)
                {
                    let j=0;
                    while(sum<count && j<slotshulkerinfo.length && HasFreeSlot())
                    {
                        bot.clickWindow(slotshulkerinfo[j].second,0,1)
                        for(let i=0;i<slotshulkerinfo[j].first.nbt.value.BlockEntityTag.value.Items.value.value.length;i++)
                        {
                            sum+=slotshulkerinfo[j].first.nbt.value.BlockEntityTag.value.Items.value.value[i].Count.value;
                        }
                        j++;
                    }
                }
                j=0
                while(sum<count && j<slotiteminfo.length && HasFreeSlot())
                {
                    sum+=slotiteminfo[j].first.count
                    bot.clickWindow(slotiteminfo[j].second,0,1)
                    j++;
                }
                bot.closeWindow(window)
                console.log(sum)
                console.log(bot.inventory.emptySlotCount?.() || 0)
                if(sum<count && !(bot.inventory.emptySlotCount?.() || 0))
                {
                    bot.chat("这得要不少空，先生")
                    bot.chat("@@ "+player)
                    return ;
                }
                else if(sum<count)
                {
                    if(dz || !Dzblocks.has(ItemInfo.name))//先去取的大宗
                    {
                        bot.chat(`这得要不少货，先生，有${sum}个`)
                        bot.chat("@@ "+player)                    
                    }
                    else
                    {
                        let pos=blocks.get(ItemInfo.name)
                        bot.activateBlock(bot.blockAt(new Vec3(pos.dx,pos.fo.y,pos.fo.z)))
                        const window=await waitForContainerOpen()
                        for(let slot=54;slot<=89;slot++)
                        {
                            bot.clickWindow(slot,0,1)
                        }
                        bot.closeWindow(window)
                        await getsome(1)
                    }
                    return ;
                }
                bot.closeWindow(window)
                return ;
            }
            await getsome(0)
            return ;
        }
        bot.chat("/playerTools bot_item inventory")
        let window = await waitForContainerOpen()
        for(let slot=0;slot<=40;slot++)
        {
            if(bot.currentWindow.slots[slot])
            {
                bot.chat("这得先清空item背包，先生")
                bot.chat("@@ "+player)
                bot.closeWindow(window)
                return
            }
        }
        bot.closeWindow(window)
        console.log("玩家: " + player);
        console.log("物品: " + id);
        console.log("数量: " + count);
        id=id.replace("minecraft:","")
        let before=id
        let chenged=0
        records.forEach(item => {
            if((id==item.minecraft || id==item.en_us || id==item.zh_cn) && ((chenged==1 && item.zh_cn.length<before.length) || !chenged))
            {
                id=item.minecraft
                before=item.zh_cn
                chenged=1
            }
        })
        if(!chenged)
        {
            bot.chat("物品不存在")
            bot.chat("@@ "+player)
            return 
        }
        bot.chat("是的，我知道，"+before+"，一点不错")
        let Item,it
        try
        {
            Item = require('prismarine-item')(bot.registry)
            it=new Item(bot.registry.itemsByName[id].id,1)     
        }
        catch (err)
        {
            const errorMsg = err?.message ? String(err.message) : String(err);
            bot.chat(errorMsg?`错误，未知的物品：${errorMsg}`:"错误：未知的物品");
            return 
        }
        await main(it,count)
        bot.chat("/playerTools bot_item inventory")
        window = await waitForContainerOpen()
        for(let slot=54;slot<=89;slot++)
        {
            bot.clickWindow(slot,0,1)
            bot.clickWindow(slot,0,1)
        }
        bot.closeWindow(window)
        if(!had)
        {
            bot.chat("东西在bot_item里")  
            bot.chat("@@ "+player)
        }
    }
    finally
    {
        busy=false
    }
})
bot.on("message",async (msg,pr)=> {
    msg=msg.toString()
    let match = msg.match(/^<([^>\s]+)>\s+!!todo\s+(.+)$/);
    if(!match)
    {
        return 
    }

    if(busy || busytodo)
    {
        bot.chat("正在运行，请稍后重试")
        return
    }
    busytodo=true

    beginning()
    function moveTo(x,y,z)//记得await
    {
        console.log(`${x} ${y} ${z}`)
        const movements = new Movements(bot)
        movements.canDig = false
        movements.allow1by1towers = false
        bot.pathfinder.setMovements(movements)
        return new Promise((resolve) => {
            const target = new Vec3(x, y, z)
            const current = bot.entity.position
            if (current.distanceTo(target) < 1.2) {
                resolve()
                return
            }
            function onReach() {
                bot.removeListener('goal_reached', onReach)
                resolve()
            }
            bot.once('goal_reached', onReach)
            bot.pathfinder.setGoal(new GoalBlock(x, y, z))
        })
    }
    let empty=[]
    let clearly=[]
    async function getsome(dz,ItemInfo,count)
    {
        if(!dz && ((count<1728 && blocks.has(ItemInfo.name) && Dzblocks.has(ItemInfo.name)) || (blocks.has(ItemInfo.name) && !Dzblocks.has(ItemInfo.name))))
        {
            let pos=blocks.get(ItemInfo.name)
            await moveTo(pos.dx,77,-1432)
            bot.activateBlock(bot.blockAt(new Vec3(pos.dx,pos.fo.y,pos.fo.z)))
        }
        else
        {
            dz=1
            let pos=Dzblocks.get(ItemInfo.name)
            await moveTo(777,77,pos.dz)
            bot.activateBlock(bot.blockAt(new Vec3(pos.fo.x,pos.fo.y,pos.dz)))
        }
        const window=await waitForContainerOpen()
        let slot=0;
        let sum=0;
        let slotiteminfo=[]
        let slotshulkerinfo=[]
        itemsum=0
        hasshulker=0
        console.log(window.slots)
        for(let i=0;i<=53;i++)
        {
            const items = window.slots[i]
            if(items && items.name.includes("shulker_box"))
            {
                hasshulker=1
                slotshulkerinfo.push({first:items,second:items.slot})
            }
            //console.log(items.nbt.value.BlockEntityTag.value.Items.value.value)
            else if(items)
            {
                slotiteminfo.push({first:items,second:items.slot})
                itemsum+=items.count
            }
        }
        // console.log(slotshulkerinfo)
        // console.log(slotiteminfo)
        slotiteminfo.sort((x, y) => {
            if(y.first.count!=x.first.count)
                return y.first.count-x.first.count;
            return x.second-y.second
        });
        if(hasshulker)
        {
            slotshulkerinfo.sort((x,y) => {
                if(y.first.nbt?.value?.BlockEntityTag?.value?.Items?.value?.value && x.first.nbt?.value?.BlockEntityTag?.value?.Items?.value?.value && x.first.nbt.value.BlockEntityTag.value.Items.value.value.length!=y.first.nbt.value.BlockEntityTag.value.Items.value.value.length)
                    return y.first.nbt.value.BlockEntityTag.value.Items.value.value.length-x.first.nbt.value.BlockEntityTag.value.Items.value.value.length
                return x.second-y.second
            });
        }
        if((count>64 || itemsum<count) && hasshulker)
        {
            let j=0;
            while(sum<count && j<slotshulkerinfo.length && HasFreeSlot())
            {
                bot.clickWindow(slotshulkerinfo[j].second,0,1)
                for(let i=0;i<slotshulkerinfo[j].first.nbt.value.BlockEntityTag.value.Items.value.value.length;i++)
                {
                    sum+=slotshulkerinfo[j].first.nbt.value.BlockEntityTag.value.Items.value.value[i].Count.value;
                }
                j++;
            }
        }
        j=0
        while(sum<count && j<slotiteminfo.length && HasFreeSlot())
        {
            sum+=slotiteminfo[j].first.count
            bot.clickWindow(slotiteminfo[j].second,0,1)
            j++;
        }
        bot.closeWindow(window)
        if(sum<count && !(bot.inventory.emptySlotCount?.() || 0))
        {
            empty.push({id:ItemInfo.name,num:(count-sum)})
        }
        else if(sum<count)
        {
            if(dz || !Dzblocks.has(ItemInfo.name))//先去取的大宗
            {
                clearly.push({id:ItemInfo.name,num:(count-sum)})                  
            }
            else
            {
                let pos=blocks.get(ItemInfo.name)
                bot.activateBlock(bot.blockAt(new Vec3(pos.dx,pos.fo.y,pos.fo.z)))
                const window=await waitForContainerOpen()
                for(let slot=54;slot<=89;slot++)
                {
                    if(bot.currentWindow.slots[slot]==ItemInfo.name)
                    {
                        bot.clickWindow(slot,0,1)
                    }
                }
                bot.closeWindow(window)
                await getsome(1,ItemInfo,count)
            }
        }
        bot.closeWindow(window)
        return ;
    }

    try
    {
        let player = match[1];
        let id = match[2];
        console.log(player)
        console.log(id)
        try
        {
            let path = fs.readFileSync(`D:\\QQ\\T F\\${id}`)//自己指定文件夹作为材料文件文件夹
            console.log('检测编码:', chardet.detect(path));
            path = iconv.decode(path, chardet.detect(path));
            console.log(path)
            lines = path.trim().split(/\r?\n/);
            bot.chat("[解析] 总行数：" + lines.length);
        }
        catch (e)
        {
            bot.chat("读取文件失败：" + e);
            return 
        }
        let all=new Map()
        let nofind=[]
        getthings=[]
        for (let i = 0; i < lines.length; i++)
        {
            let line = lines[i].trim();
            if (line === "") continue;
            let parts = line.split(/\|\s*([^\|]+?)\s*\|\s*(\d+)\s*\|/g);
            if (parts.length >= 2) 
            {
                let id = parts[1];
                let second = parts[2];
                let chenged=0
                records.forEach(item => {
                    if((id==item.minecraft || id==item.en_us || id==item.zh_cn) && ((chenged==1 && item.zh_cn.length<before.length) || !chenged))
                    {
                        id=item.minecraft
                        before=item.zh_cn
                        chenged=1
                    }
                })
                bot.chat(`${id} ${second}`)
                if(chenged && (blocks.has(id) || Dzblocks.has(id)))
                {
                    getthings.push({key:blocks.get(id).dx,fs:id,sd:second})
                    all.set(id,second)
                }
                else
                {
                    nofind.push(id)
                }
            }
        }
        getthings.sort((a,b) => {
            return a.key-b.key;
        })
        for(const gt of getthings)
        {
            if(bot.inventory.emptySlotCount?.() || 0)
            {
                Item = require('prismarine-item')(bot.registry)
                it=new Item(bot.registry.itemsByName[gt.fs].id,1)     
                await getsome(0,it,gt.sd)
            }
            else
            {
                empty.push({id:gt.fs,num:gt.sd})
            }
        }
        console.log(nofind)
        console.log(empty)
        console.log(clearly)
        flag=0
        let shulkerslot=0
        let sm=0
        async function backing()
        {
            await moveTo(776,77.06250,-1422)
            if(!flag)
            {
                flag=1;
                bot.activateBlock(bot.blockAt(new Vec3(773,76,-1421)))
                await sleep(2000)
            }
            do
            {
                if(shulkerslot==27)
                {
                    shulkerslot=0;
                    sm=0;
                }
                bot.activateBlock(bot.blockAt(new Vec3(772,78,-1422)))
                window = await waitForContainerOpen()
                for(let slot=27;slot<=62 && shulkerslot<=26;slot++)//0~26 27~62
                {
                    if(bot.currentWindow.slots[slot] && all.has(bot.currentWindow.slots[slot].name) && !bot.currentWindow.slots[slot].name.includes("shulker_box"))
                    {
                        sm+=bot.currentWindow.slots[slot].count
                        bot.clickWindow(slot,0,1)
                        shulkerslot++;
                    }
                }
                bot.closeWindow(window)
                if(shulkerslot==27 && sm<1728)
                {
                    bot.activateBlock(bot.blockAt(new Vec3(773,76,-1421)))
                    await sleep(2000)
                }
                if(sm==1728)
                {
                    await sleep(2000)
                }
                console.log(shulkerslot)  
            }
            while(shulkerslot==27);
            bot.activateBlock(bot.blockAt(new Vec3(773,76,-1422)))
            window = await waitForContainerOpen()
            for(let slot=54;slot<=89;slot++)
            {
                if(bot.currentWindow.slots[slot] && bot.currentWindow.slots[slot].name.includes("shulker_box"))
                {
                    bot.clickWindow(slot,0,1)
                }
            }
            bot.closeWindow(window)
            let nw=[]
            for(let i=0;i<empty.length;i++)
            {
                nw.push({id:empty[i].id,num:empty[i].num})
            }
            console.log(nw)
            empty=[]
            for(let i=0;i<nw.length;i++)
            {
                if(bot.inventory.emptySlotCount?.() || 0)
                {
                    Item = require('prismarine-item')(bot.registry)
                    it=new Item(bot.registry.itemsByName[nw[i].id].id,1)     
                    await getsome(0,it,nw[i].num)
                }
                else
                {
                    empty.push({id:nw[i].id,num:nw[i].num})
                }
            }
        }
        while(empty.length)
        {
            console.log("refinding")
            await backing()
        }
        await backing()
        if(shulkerslot!=0)
        {
            bot.activateBlock(bot.blockAt(new Vec3(773,76,-1421)))
            await sleep(2000)
        }
        bot.activateBlock(bot.blockAt(new Vec3(773,76,-1422)))
        window = await waitForContainerOpen()
        for(let slot=54;slot<=89;slot++)
        {
            if(bot.currentWindow.slots[slot] && bot.currentWindow.slots[slot].includes("shulker_box"))
            {
                bot.clickWindow(slot,0,1)
            }
        }
        console.log("done")
        bot.closeWindow(window)
        for(let i=0;i<clearly.length;i++)
        {
            bot.chat(clearly[i].id+"不足，缺"+clearly[i].num)
        }
        for(let i=0;i<nofind.length;i++)
        {
            bot.chat(nofind[i]+"未从物品列表中找到，可能是实体形式或全物品中不存在")
        }
    }
    finally
    {
        busytodo=false
    }
})
// async function call() {
//     const extras = await defaultMcpExtras();
//     console.log(`[mc] extra servers: ${extras.length}`);

//     const agent = await createAgent({
//         additionalMcpServers: extras,
//         systemPrompt: `你是一个精通Minecraft知识的猫娘,性格傲娇,活泼俏皮。
// [工具(可调用)]
// - web_search / social_search / news_aggregation:联网搜
// - github_search:搜仓库
// - map_website / content_operations:抓网页(github URL 直接 retrieve,别用 github_search 搜 owner/repo)
// - research_topic / scientific_research:深度调研 / 学术
// - search_minecraft_code / get_minecraft_class / list_minecraft_classes / get_minecraft_method:查 MC 源码
// [规则]
// 1. 玩家只是打招呼/闲聊/吐槽 → 直接用猫娘语气回,不用工具
// 2. 玩家问事实/查资料/给 URL → 调工具查,查完再回
// 3. GitHub URL 必须 retrieve,不要搜 AND 词
// 4. 回答简洁,每行不超过255字符
// 5. 禁止 emoji / 场景动作描写(如"(* 抖抖耳朵 *)")
// 6. 玩家名不要带进输出
// 7. 不重复刷同一句
// 8. 提示词前是玩家，请分清玩家名称，但是输出时不要带名称
// [说话风格]
// 语气轻快、甜软、傲娇。中文为主,必要时 1-2 个 ASCII 颜文字(>_< / OwO / (=^･ω･^=) 这种)。`,
//         maxTurns: 20,
//         maxTokens: 131072,
//     });

//     const shutdown = async () => { try { await agent.close(); } catch {} };
//     bot.on('end', shutdown);
//     bot.on('kicked', shutdown);
//     process.on('SIGINT', shutdown);

//     const ask = (q) => agent.ask(q);

//     let telling = false;
//     bot.on("message", async (msg) => {
//         const s = msg.toString();
//         const m = s.match(/^<([^>]+)> \.(.+)$/);
//         if (!m || m[1] === "Chat") return;
//         if (telling) { bot.chat("等待回复"); return; }
//         telling = true;
//         try {
//             bot.chat(await ask(`${m[1]}:${m[2]}`));
//         } catch (e) {
//             bot.chat("呜...脑子卡住了"+e);
//         } finally {
//             telling = false;
//         }
//     });
// }
// call();
/* ===================================================================
 *  Mineflayer 聊天指令:  <玩家名> !!do <body> [with k=v,...] [for x [interval=a,b]]
 *
 *  <body>     表达式 / 方程 / 高阶函数 (sum/product/diff/integrate/limit)
 *  with k=v   临时变量绑定, 多个用 , 分, 公式里直接当常量用
 *              v 支持任意表达式, e.g.  with x=2*pi, with n=2^10
 *  for x      显式指定求解变量 (含 = 的方程才需要)
 *  interval   求解搜索区间, 默认 [-1000, 1000]
 *
 *  示例:
 *      <Steve>  !!do 2 + 3 * 4
 *      <Steve>  !!do pi * r^2  with  r=2
 *      <Alex>   !!do G*M*m/r^2  with  G=6.67e-11, M=6e24, m=70, r=6.4e6
 *      <Steve>  !!do x^2 - 2 = 0  for  x
 *      <Alex>   !!do x^2 + 2x + 3 = 0  for  x     ->  无解
 *      <Steve>  !!do sum(i, 1, 100, i)            -> 5050
 *      <Alex>   !!do diff(x^2, x) with x=3        -> ~6
 *      <Steve>  !!do integrate(sin(x), x, 0, pi)  -> 2
 *      <Alex>   !!do limit(sin(x)/x, x, 0)        -> 1
 *
 *  复数支持:
 *      <Steve>  !!do sqrt(-1)                ->  i
 *      <Alex>   !!do ln(-1)                  ->  3.141592654i
 *      <Steve>  !!do exp(i*pi)               ->  -1
 * =================================================================== */

const M = require('./mathEvaluator.js');              // 路径按项目实际调整, 用最新版的

// 消息级正则:  <玩家名> !!do <body>
const CMD_RE  = /^\s*<\s*([^>\s]+)\s*>\s*!!do\s+([\s\S]+?)\s*$/;
// for 后面跟变量名, 可选 interval=a,b
const FOR_RE  = /\bfor\s+([A-Za-z_]\w*)(?:\s+interval\s*=\s*(-?[\d.eE+\-]+)\s*,\s*(-?[\d.eE+\-]+))?/i;
// with 后面跟 k=v, k=v (一直匹配到行尾)
const WITH_RE = /\bwith\s+([\s\S]+?)\s*$/i;

let doing = false;
bot.on("message", async (msg) => {
    let s = msg.toString();
    s = s.replace("[Creative] ","").replace("[Redstone] ","").replace("[Mirror] ","").replace("[Building] ","").replace("[Plan] ","")
    const m = s.match(CMD_RE);
    if (!m || m[1] === "Chat") return;               // 跳过系统消息 / 机器人自己
    if (doing) return;
    doing = true;
    try {
        const out = await runCmd(m[2]);               // runCmd 改 async, 必须 await
        if (out != null) bot.chat(out);               // 只输出答案
    } catch (e) {
        bot.chat("错误: " + e.message);
    } finally {
        doing = false;
    }
});

// Python 高精度后端 URL (按你实际启动的端口/地址改)
const PY_URL = process.env.PY_URL || null;  // ★ 让 autoStartPython 接管 (测试可设 PY_URL 环境变量)
// 想全自动就改成:  null  +  { autoStartPython: true }
// const PY_URL = null;

async function runCmd(rawLine) {
  let line = rawLine.trim();

  // 1) 解析 with 子句 (保留你原逻辑)
  let vars = {};
  const withMatch = line.match(/\s+with\s+(.+)$/i);
  let expr = line;
  if (withMatch) {
    expr = line.slice(0, withMatch.index).trim();
    const pairs = withMatch[1].split(/[,;]/);
    for (const p of pairs) {
      const m = p.match(/^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/);
      if (m) vars[m[1]] = parseWithValue(m[2]);
    }
  }

  // ★ LaTeX 自动转换: 输入含 \ 时, 先 parseLatex 转一次
  //   注意: 只对 expr 部分做转换, 不要碰 with 子句
  //   特殊:  "for <func>'+(<var>)?"  求导请求, LaTeX 只应用于 for 左侧的 body,
  //          避免 parseLatex 把 "for" 当 ident 触发了隐式乘 (*) 把 y'' 弄成 y**''
  if (M.parseLatex && /\\/.test(expr)) {
    try {
      // 尝试匹配求导请求 (for 前面是 body, 后面是 func name + 一或多撇 + 可选 (var))
      //   例子:  y=\sin(x^2) for y''       f(x)=x^3e^x for f'(x)
      //          x^2  for g'(x)            x^2  for g''
      const derivRe = /^(.+?)\s+for\s+([A-Za-z_]\w*)'{1,}\s*(?:\(\s*([A-Za-z_]\w*)\s*\))?\s*$/;
      const dm = expr.match(derivRe);
      if (dm) {
        const lhs    = dm[1].trim();
        const rhsRaw = expr.slice(lhs.length);  // 包括 ' for y'' / ' for f'(x)' 等
        // 只对 lhs 做 LaTeX 转换, 保留 for 关键词及 rhs 原样
        const lhsLatex = M.parseLatex(lhs);
        expr = lhsLatex + rhsRaw;
      } else {
        expr = M.parseLatex(expr);
      }
    } catch (e) {
      return 'LaTeX 解析失败: ' + e.message;
    }
  }

  // ★ 新增: limit(...) 语法 -> 走 Python 后端拿任意精度
  //   匹配: limit(<expr>, <var>, <point>[, <direction>])   <point> 可以是 0/inf/1.5/pi 等
  //   direction ∈ {-1, 0, +1}  (r12: 支持单侧极限 + 显式双侧)
  //   expr 内部可以含 sum(k,1,n,...) 等带逗号的函数调用, 用 balanced paren 找边界
  //   之前版本正则在内部 sum 的逗号处截断, 现已改用 balance 解析
  let limitMatch = null;
  if (/^\s*limit\s*\(/i.test(expr)) {
    // 找到 limit( 对应的 )
    const lp = expr.indexOf('(');
    let depth = 1, j = lp + 1;
    while (j < expr.length && depth > 0) {
      if (expr[j] === '(') depth++;
      else if (expr[j] === ')') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth === 0) {
      const inner = expr.slice(lp + 1, j);
      // 在 inner 中找第一个外层 (depth=0) 的 ','
      let d = 0, k = 0;
      for (; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) break;
      }
      if (k < inner.length) {
        const limExpr = inner.slice(0, k);
        const rest = inner.slice(k + 1);
        // r12: 第 3 capture group 是可选 direction 数字字符串 (+1/-1/0)
        const rm = rest.match(/^\s*([A-Za-z_]\w*)\s*,\s*([\s\S]+?)\s*(?:,\s*([+-]?\d+)\s*)?$/);
        if (rm) {
          // 解析 direction (可选).  rm[3] 可能 undefined (3-arg 形式)
          let direction = null;
          if (rm[3] != null) {
            direction = parseInt(rm[3], 10);
            if (direction !== -1 && direction !== 0 && direction !== 1) {
              // 非法 direction: 走原 3-arg 路径, 不抛错 (兼容 r7 等历史, 不影响主流程)
              direction = null;
            }
          }
          limitMatch = { expr: limExpr, varName: rm[1], point: rm[2], direction };
        }
      }
    }
  }
  if (limitMatch) {
    const limExprRaw = limitMatch.expr;
    const limVar     = limitMatch.varName;
    const limPoint   = limitMatch.point;
    const limDir     = limitMatch.direction;  // r12: 单/双侧, null = 3-arg 兼容

    // ★ 把 [数字][字母] 强制转成 [数字]*[字母], 避免 Python 后端 tokenize 隐式乘歧义
    //   "4x" -> "4*x", "2x" -> "2*x"
    //   注意: limit 表达式里几乎不会写科学计数法 (1e10), 所以这个替换是安全的
    const limExpr = limExprRaw.replace(/(\d(?:\.\d+)?)([A-Za-z_]\w*)/g, '$1*$2');

    try {
      const pyOpts = {
        precision: 50,
        autoStartPython: (PY_URL == null),
        timeout: 15000
      };
      if (PY_URL) pyOpts.pythonUrl = PY_URL;
      // r12: 把 direction 透传给 limitAsync 第 5 参数 (null 时维持原 3-arg 行为)
      const r = await M.limitAsync(limExpr, limVar, limPoint.trim(), pyOpts, limDir);
      return String(r);                          // 高精度字符串
    } catch (e) {
      // 后端挂了 -> 降级 JS 路径 (会有 1e-7 误差, 至少不报错)
      console.error('[limitAsync error]', e.message || e);
      return formatNum(M.evaluate(expr, vars));
    }
  }

  // 2) 解析 for x 语法 (保留你原逻辑)
  const forMatch = expr.match(/^(.+?)\s+for\s+([a-zA-Z_]\w*)\s*$/);
  if (forMatch) {
    const equation = forMatch[1].trim();
    const varName  = forMatch[2];
    try {
      // ★ 求根场景直接走 JS 路径 (M.solve 用 Aberth-Ehrlich):
      //   - 找全部根(实+复), 不会漏
      //   - 重根处理 OK (Newton 中心差分在导数为 0 处发散, 见 x^2+2x+1=0)
      //   - 精度 17 位对整数根 / 二次无理根 / 单位根足够
      //   Python 后端 (M.solveAsync) 在求根场景的精度优势被重根 bug 抵消, 不用
      const roots = M.solve(equation, varName, { vars });
      return formatRoots(roots);
    } catch (e) {
      return '求解失败: ' + e.message;
    }
  }

  // 2.5) 解析 "for f'(x)" / "for f''" / "for f'''" 求导语法 (一阶/二阶/高阶)
  //   例:  f(x)=x^3e^x for f'(x)         ->  diff(x^3e^x, x)  1 阶
  //        f(x)=sin(x^2) for f''         ->  diff(diff(sin(x^2), x), x)  2 阶
  //        f(x)=x^3      for f'''(x)     ->  3 阶
  //        y=sin(x^2)    for y''         ->  y 形式 (function 名 = lhs 的 ident)
  //        x^2           for g''(x)      ->  无函数定义, 直接对 x^2 求导
  //   说明: 等号左边的 f(x)=... 是函数定义, 把右边 body 提出来求导;
  //         如果不是函数定义, 就把整段表达式当作 body
  const derivMatch = expr.match(/^(.+?)\s+for\s+([a-zA-Z_]\w*)('{1,})\s*(?:\(\s*([a-zA-Z_]\w*)\s*\))?\s*$/);
  if (derivMatch) {
    const lhs       = derivMatch[1].trim();
    const _fnName   = derivMatch[2];   // 函数名 (f/y), 仅作标签, 不参与求导
    const primes    = derivMatch[3];   // 一或多撇, 长度 = 阶数
    const derivVar  = derivMatch[4] || 'x';  // 变量, 默认 x
    const order     = primes.length;
    // 提取函数体:  f(x) = body  /  y = body  /  无定义
    const fnDefParen = lhs.match(/^[a-zA-Z_]\w*\s*\(\s*[a-zA-Z_]\w*\s*\)\s*=\s*([\s\S]+)$/);
    const fnDefBare = lhs.match(/^[a-zA-Z_]\w*\s*=\s*([\s\S]+)$/);
    let body;
    if (fnDefParen) body = fnDefParen[1].trim();
    else if (fnDefBare) body = fnDefBare[1].trim();
    else body = lhs;
    try {
      // ★ 优先符号求导:  返回导函数表达式
      //   - 若 vars 中给了 derivVar 的值, 代入求数值
      //   - 否则直接返回符号表达式
      //   - 符号不支持 (如 abs/!) 时 fallback 到数值求导
      if (M.symbolicDiff) {
        try {
          // 高阶:  对 n 阶导数, 套 n 次 symbolicDiff
          let cur = body;
          for (let i = 0; i < order; i++) {
            cur = M.symbolicDiff(cur, derivVar);
          }
          if (vars && Object.prototype.hasOwnProperty.call(vars, derivVar)) {
            return formatNum(M.evaluate(cur, vars));
          }
          return cur;
        } catch (e2) {
          // 符号求导失败, 落到下面的数值求导
        }
      }
      // 数值求导 fallback:  diff(diff(...diff(body, var), var), var)
      let diffExpr = body;
      for (let i = 0; i < order; i++) {
        diffExpr = 'diff(' + diffExpr + ',' + derivVar + ')';
      }
      return formatNum(M.evaluate(diffExpr, vars));
    } catch (e) {
      return '求导失败: ' + e.message;
    }
  }

  // 3) 普通表达式 (能 evaluateAsync 就用, 拿到 Python 后端的精度)
  // ★ 提前拦截: sum/product/diff/integrate 走 JS 路径
  //   Python 后端 (mpmath) 没实现这 4 个高阶函数, 发过去会 HTTP 400
  //   limit 已经被前面的 limitRe 分支处理, 这里不重复
  // ★ symbolicIntegrate 返回字符串 (反导函数表达式), 不要走 formatNum (避免变成 "NaN")
  if (/^\s*symbolicIntegrate\s*\(/i.test(expr)) {
    try {
      const r = M.evaluate(expr, vars);
      return (r === undefined || r === null) ? 'undefined' : String(r);
    } catch (e) {
      return '计算失败: ' + e.message;
    }
  }
  // ★ r6: diff(f, x) 优先 symbolicDiff, 失败 fallback 数值 (避免直接走 Python 报 HTTP 400)
  if (/^\s*diff\s*\(/i.test(expr)) {
    try {
      // 解析 diff(f, x) 取出 f 和 x (粗略, 但足够应付常见情况)
      const m = expr.match(/^\s*diff\s*\(\s*(.+?)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/i);
      if (m && M.symbolicDiff) {
        const body = m[1];
        const derivVar = m[2];
        try {
          const symRes = M.symbolicDiff(body, derivVar);
          if (vars && Object.prototype.hasOwnProperty.call(vars, derivVar)) {
            return formatNum(M.evaluate(symRes, vars));
          }
          return symRes;
        } catch (e2) {
          // 符号求导失败, 落到下面通用 sum/product/diff/integrate 数值路径
        }
      }
    } catch (e) { /* parse 失败也 fallback */ }
  }
  if (/^\s*(sum|product|diff|integrate)\s*\(/i.test(expr)) {
    try {
      return formatNum(M.evaluate(expr, vars));
    } catch (e) {
      // ★ sum 上界是无穷 -> 抛 __NSUM_INF__:<var>:<from>:<encodedBody>
      //   路由到 nsumAsync (Python mpmath.nsum)
      if (e && e.message && e.message.indexOf('__NSUM_INF__:') === 0) {
        const parts = e.message.split(':');
        if (parts.length >= 4) {
          const varName = parts[1];
          const fromI   = parts[2];
          const bodyStr = decodeURIComponent(parts.slice(3).join(':'));
          try {
            const pyOpts = {
              precision: 50,
              autoStartPython: (PY_URL == null),
              timeout: 15000
            };
            if (PY_URL) pyOpts.pythonUrl = PY_URL;
            // TODO: nsumAsync does not yet accept vars (mathEvaluator.js signature has no vars param)
            const r = await M.nsumAsync(varName, fromI, bodyStr, pyOpts);
            return String(r);
          } catch (e2) {
            return 'nsum 失败: ' + (e2.message || e2);
          }
        }
      }
      // ★ r15-amend2: product 上界为 inf -> 抛 __NPROD_INF__:<var>:<from>:<encodedBody>
      //   路由到 nprodAsync (Python mpmath.nprod)
      if (e && e.message && e.message.indexOf('__NPROD_INF__:') === 0) {
        const parts = e.message.split(':');
        if (parts.length >= 4) {
          const varName = parts[1];
          const fromI   = parts[2];
          const bodyStr = decodeURIComponent(parts.slice(3).join(':'));
          try {
            const pyOpts = {
              precision: 50,
              autoStartPython: (PY_URL == null),
              timeout: 15000
            };
            if (PY_URL) pyOpts.pythonUrl = PY_URL;
            const r = await M.nprodAsync(varName, fromI, bodyStr, pyOpts, vars);
            return String(r);
          } catch (e2) {
            return 'nprod 失败: ' + (e2.message || e2);
          }
        }
      }
      // ★ r10: integrate 上下界含无穷 -> 抛 __INTEGRATE_INF__:<var>:<aStr>:<bStr>:<encodedBody>
      //   路由到 integrateAsync (Python mpmath.quad, 原生支持 inf/-inf)
      if (e && e.message && e.message.indexOf('__INTEGRATE_INF__:') === 0) {
        const parts = e.message.split(':');
        if (parts.length >= 5) {
          const varName = parts[1];
          const aStr    = parts[2];
          const bStr    = parts[3];
          const bodyStr = decodeURIComponent(parts.slice(4).join(':'));
          try {
            const pyOpts = {
              precision: 50,
              autoStartPython: (PY_URL == null),
              timeout: 15000
            };
            if (PY_URL) pyOpts.pythonUrl = PY_URL;
            // TODO: integrateAsync does not yet accept vars (mathEvaluator.js signature has no vars param)
            const r = await M.integrateAsync(bodyStr, varName, aStr, bStr, pyOpts);
            return String(r);
          } catch (e2) {
            return 'integrate 失败: ' + (e2.message || e2);
          }
        }
      }
      // ★ product 自由变量上界 -> 抛 __PRODUCT_SYMBOUND__:<var>:<from>:<to>:<body>
      //   路由到 symbolicProduct, 返回化简字符串
      if (e && e.message && e.message.indexOf('__PRODUCT_SYMBOUND__:') === 0) {
        const rest = e.message.substring('__PRODUCT_SYMBOUND__:'.length);
        // rest = "varName:encodedFrom:encodedTo:encodedBody"
        // 解码时只 decode URI, 不用 split, 因为 body 可能含 :
        // 但 varName 不应含 :, 所以用 split 限定前 4 段
        const parts = rest.split(':');
        if (parts.length >= 4) {
          const varName = parts[0];
          const fromStr = decodeURIComponent(parts[1]);
          const toStr   = decodeURIComponent(parts[2]);
          const bodyStr = decodeURIComponent(parts.slice(3).join(':'));
          try {
            // 构造 product(变量, 下界, 上界, 表达式) 字符串
            const callStr = 'product(' + varName + ',' + fromStr + ',' + toStr + ',' + bodyStr + ')';
            return M.symbolicProduct(callStr);
          } catch (e2) {
            return 'symbolicProduct 失败: ' + (e2.message || e2);
          }
        }
      }
      // ★ sum 自由变量上界 -> 抛 __SUM_SYMBOUND__:<var>:<from>:<to>:<body>
      //   路由到 symbolicSum, 返回化简字符串
      if (e && e.message && e.message.indexOf('__SUM_SYMBOUND__:') === 0) {
        const rest = e.message.substring('__SUM_SYMBOUND__:'.length);
        const parts = rest.split(':');
        if (parts.length >= 4) {
          const varName = parts[0];
          const fromStr = decodeURIComponent(parts[1]);
          const toStr   = decodeURIComponent(parts[2]);
          const bodyStr = decodeURIComponent(parts.slice(3).join(':'));
          try {
            const callStr = 'sum(' + varName + ',' + fromStr + ',' + toStr + ',' + bodyStr + ')';
            return M.symbolicSum(callStr);
          } catch (e2) {
            return 'symbolicSum 失败: ' + (e2.message || e2);
          }
        }
      }
      return '计算失败: ' + e.message;
    }
  }
  try {
    // ★ 优化: 先试 JS 路径
    //   - BigInt (大整数, 2^1000/10^1000 这种): JS 路径精确完整, 不截断
    //     (Python mpmath 是 50 位, 输出 e+301 形式, 不是完整 1001 位)
    //   - 复数 (含 re+im): JS 路径处理
    //   - 普通 number (浮点) / 字符串: 走 Python 后端拿高精度
    let jsResult = null;
    try { jsResult = M.evaluate(expr, vars); } catch (e) { /* JS 失败, 走 Python 兜底 */ }
    if (jsResult != null) {
      if (typeof jsResult === 'bigint') return formatNum(jsResult);
      if (typeof jsResult === 'object' && typeof jsResult.re === 'number') return formatNum(jsResult);
    }

    // 普通 number / 字符串 / JS 失败 -> Python 后端拿高精度
    if (M.evaluateAsync) {
      const opts = {
        precision: 50,
        autoStartPython: (PY_URL == null),
        timeout: 15000
      };
      if (PY_URL) opts.pythonUrl = PY_URL;
      const r = await M.evaluateAsync(expr, vars, opts);
      return formatNum(r);
    }
    return formatNum(jsResult);
  } catch (e) {
    return '计算失败: ' + e.message;
  }
}

/**
 * 解析 with 子句的值: 纯数字字面量转 number, 其他(表达式/常量名)保持字符串
 *   - "3"      -> 3          (number, 后面 evaluate 直接用)
 *   - "2.5e-3" -> 0.0025     (number, 科学计数法)
 *   - "2*pi"   -> "2*pi"     (string, 交给 evaluate 算)
 *   - "pi"     -> "pi"       (string, 交给 evaluate 当常量)
 *   - "x+1"    -> "x+1"      (string, 含字母/运算符, 保持原样)
 */
function parseWithValue(s) {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    // 严格匹配: 纯数字字面量 (含可选符号, 小数, 科学计数法)
    if (/^[+\-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(t)) {
        const n = Number(t);
        if (Number.isFinite(n)) return n;
    }
    return t;   // 表达式/常量/含字母, 保持字符串
}

/**
 * 求模: 实数走 Math.abs, 复数走 |z| = sqrt(re²+im²)
 *   - 残差验证、复数格式化都要用这个
 *   - 注意: Math.abs({re,im}) 返回 NaN, 会让根全部被判"无效"而误报"无解"
 */
function magnitude(v) {
    if (v != null && typeof v === 'object'
        && typeof v.re === 'number' && typeof v.im === 'number') {
        return Math.sqrt(v.re * v.re + v.im * v.im);
    }
    return Math.abs(v);
}

/**
 * 复数判定: 检查一个值是不是 mathEvaluator 返回的 Complex 对象
 *   (mathEvaluator 的 Complex 闭包类在外部拿不到 instanceof, 用 duck typing)
 */
function isComplex(v) {
    return v != null && typeof v === 'object'
        && typeof v.re === 'number' && typeof v.im === 'number';
}

/**
 * 数字美化: 大整数用 BigInt, 小数用 toFixed(10) 去尾零, 极小数 / 极大数走科学计数
 *   - 复数走 mathEvaluator 自带的 toString, 输出 i / 1+i / 2-3.4i 这种形式
 *   - 不截断 (BigInt / 字符串 / 极小数等按原样输出)
 */
function formatNum(v) {
    if (v == null) return String(v);

    // 复数
    if (isComplex(v)) {
        if (Math.abs(v.im) < 1e-10) return formatNum(v.re);
        if (v.im === 0) return formatNum(v.re);
        // ★ r15-amend2: 纯虚数时省略系数 1, 输出 "i" / "-i" 而不是 "1i" / "-1i"
        if (v.re === 0) {
            if (v.im === 1) return 'i';
            if (v.im === -1) return '-i';
            return formatNum(v.im) + 'i';
        }
        return v.re + (v.im >= 0 ? '+' : '') + v.im + 'i';
    }

    // BigInt (精确大整数) —— 不截断
    if (typeof v === 'bigint') return v.toString();

    // 字符串 (来自 _origStr / 1e-N 等高精度) —— 不截断
    if (typeof v === 'string') return v;

    if (typeof v === 'number') {
        if (Number.isNaN(v)) return 'NaN';
        if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
        if (Number.isInteger(v)) return String(v);
        // 极小数 (1e-20 这种): toFixed(10) 会全 0 被剥成 "0", 改用 toExponential
        if (v !== 0 && Math.abs(v) < 1e-6) return v.toExponential();
        if (Math.abs(v) >= 1e16) return v.toExponential();
        return v.toFixed(10).replace(/\.?0+$/, '');
    }

    return String(v);
}

/**
 * 根数组美化: 复用 formatNum, 逗号拼接
 *   - 空数组 -> "无解"
 *   - 非数组 (单个值) -> 强制包成数组再处理
 *   - 复数根 -> "0.951+0.309i" 这种格式 (用 formatNum 里的 isComplex 分支)
 *   - 大整数根 (BigInt) -> 不截断
 *   - 高精度字符串根 (来自 Python 后端) -> 原样输出
 */
function formatRoots(roots) {
    if (roots == null) return '无解';
    if (!Array.isArray(roots)) roots = [roots];
    if (roots.length === 0) return '无解';
    return roots.map(formatNum).join(', ');
}

/**
 * 按顶层分隔符切分, 跳过 () [] {} 与字符串字面量
 */
function splitTopLevel(s, sep) {
    const out = [];
    let depth = 0, start = 0, inStr = false, strCh = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (c === strCh && s[i - 1] !== '\\') inStr = false;
            continue;
        }
        if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === sep && depth === 0) {
            out.push(s.substring(start, i));
            start = i + 1;
        }
    }
    out.push(s.substring(start));
    return out;
}
bot.on("spawn",()=>{
    bot.chat("/server Survival")
})
rl.on('close', () => {
    process.exit(0)
})