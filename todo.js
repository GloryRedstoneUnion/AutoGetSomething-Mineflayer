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
 *  <玩家名>   发送指令的玩家 (用于显示和过滤自己)
 *  <body>     表达式 或 方程 (含 = 时按方程处理)
 *  with k=v   临时变量绑定, 多个用 , 分, 公式里直接当常量用
 *  for x      显式指定求解变量 (含 = 的方程才需要)
 *  interval   求解搜索区间, 默认 [-1000, 1000]
 *
 *  示例:
 *      <Steve>  !!do 2 + 3 * 4
 *      <Steve>  !!do pi * r^2  with  r=2
 *      <Alex>   !!do G*M*m/r^2  with  G=6.67e-11, M=6e24, m=70, r=6.4e6
 *      <Steve>  !!do x^2 - 2 = 0  for  x
 *      <Alex>   !!do x^2 + 2x + 3 = 0  for  x     ->  无解
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
        bot.chat(runCmd(m[2]));                       // 只输出答案
    } catch (e) {
        bot.chat("错误: " + e.message);
    } finally {
        doing = false;
    }
});

function runCmd(rawBody) {
    let body = rawBody;

    // 1) 剥 "for x [interval=a,b]"
    const forM = body.match(FOR_RE);
    let solveVar = null, interval = null;
    if (forM) {
        solveVar = forM[1];
        body = body.slice(0, forM.index) + body.slice(forM.index + forM[0].length);
        if (forM[2] != null) interval = [Number(forM[2]), Number(forM[3])];
    }
    body = body.trim();

    // 2) 剥 "with k=v, k=v"
    const withM = body.match(WITH_RE);
    let inlineVars = {};
    if (withM) {
        body = body.slice(0, withM.index).trim();
        for (const p of splitTopLevel(withM[1], ',')) {
            const kv = p.trim().match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
            if (!kv) throw new Error(`with 语法错误: "${p.trim()}", 应为 名字=数字`);
            const num = Number(kv[2]);
            if (Number.isNaN(num)) throw new Error(`with 值 "${kv[2]}" 不是有效数字`);
            inlineVars[kv[1]] = num;
        }
    }

    // 3) 执行
    if (solveVar) {
        const eq = body.includes('=') ? body : body + ' = 0';
        const opts = interval ? { start: interval[0], end: interval[1] } : {};
        let roots = M.solve(eq, solveVar, Object.assign({ vars: inlineVars }, opts));
        if (!Array.isArray(roots)) roots = [roots];

        // ★ 残差验证: 把 x=r 代回原方程, |f(r)| 太大的视为假根剔除
        //    防止 mathEvaluator 在某些版本上返回"近零极值"假根
        //    兼容复数返回值: 用 |z| = sqrt(re²+im²), 不要用 Math.abs (对对象返回 NaN)
        const [lhs, rhs] = eq.split('=');
        const expr = `(${lhs}) - (${rhs})`;
        const valid = roots.filter(r => {
            const env = Object.assign({ [solveVar]: r }, inlineVars);
            return magnitude(M.evaluate(expr, env)) < 1e-6;
        });

        return valid.length === 0
            ? "无解"
            : valid.map(formatNum).join(', ');
    } else {
        return formatNum(M.evaluate(body, inlineVars));
    }
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
 * 数字美化: 大整数用 BigInt, 小数用 toFixed(10) 去尾零, 永远不用科学计数
 *   - 复数走 mathEvaluator 自带的 toString, 输出 i / 1+i / 2-3.4i 这种形式
 */
function formatNum(v) {
    if (v == null) return String(v);
  
    // 复数
    if (typeof v === 'object' && typeof v.re === 'number' && typeof v.im === 'number') {
      if (v.im === 0) return formatNum(v.re);
      if (v.re === 0) return formatNum(v.im) + 'i';
      return v.re + (v.im >= 0 ? '+' : '') + v.im + 'i';
    }
  
    // BigInt（精确大整数）—— 不截断
    if (typeof v === 'bigint') return v.toString();
  
    // 字符串（来自 _origStr 高精度小数）—— 不截断
    if (typeof v === 'string') return v;
  
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return 'NaN';
      if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
      if (Number.isInteger(v)) return String(v);
  
      if (v !== 0 && Math.abs(v) < 1e-6) return v.toExponential();
      if (Math.abs(v) >= 1e16) return v.toExponential();
  
      return v.toFixed(10).replace(/\.?0+$/, '');
    }
  
    return String(v);
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