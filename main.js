const mineflayer = require('mineflayer')
const readline = require('readline');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalBlock } = goals
const fs = require('fs')
const { parse } = require('csv-parse/sync')
const data = fs.readFileSync('list.csv', 'utf8')

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

bot.once("login",() => {
    setTimeout(() => {
        bot.chat("/login abc123456")
    }, 1000);
})
bot.on('death', () => {
    console.log('[BOT] 死亡，准备重生...')
    bot.chat("额啊，齁哦哦哦齁噢噢噢")
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

let busy = false
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

    if(busy)
    {
        bot.chat("正在运行，请稍后重试")
        return
    }
    busy=true

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
            
            let facing=1
            blocks = new Map()
            itemFrameMap = new Map()
            Dzblocks = new Map()
        
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
                    while(sum<count && j<slotshulkerinfo.length && (bot.inventory.emptySlotCount?.() || 0))
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
                while(sum<count && j<slotiteminfo.length && (bot.inventory.emptySlotCount?.() || 0))
                {
                    sum+=slotiteminfo[j].first.count
                    bot.clickWindow(slotiteminfo[j].second,0,1)
                    j++;
                }
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
bot.on("spawn",()=>{
    bot.chat("/server Survival")
})
rl.on('close', () => {
    process.exit(0)
})