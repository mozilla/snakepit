const Router = require('express-promise-router')
const Parallel = require('async-parallel')
const clusterEvents = require('../utils/clusterEvents.js')
const pitRunner = require('../pitRunner.js')
const Pit = require('../models/Pit-model.js')
const Node = require('../models/Node-model.js')
const Group = require('../models/Group-model.js')
const Resource = require('../models/Resource-model.js')
const { getAlias } = require('../models/Alias-model.js')
const { getScript } = require('../utils/scripts.js')
const { ensureSignedIn, ensureAdmin } = require('./users.js')

const resourceParser = /resource:([^,]*),([^,]*),([^,]*)/

function getResourcesFromResult (result) {
    let workers = result.workers
    let resources = []
    if (workers.length > 0) {
        for (let line of workers[0].result.split('\n')) {
            let match = resourceParser.exec(line)
            if (match) {
                let resource = Resource.build({ 
                    type:  match[1],  
                    name:  match[3],
                    index: Number(match[2])
                })
                resources.push(resource)
            }
        }
        return resources
    } else {
        return
    }
}

var router = module.exports = new Router() 

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.status(200).send((await Node.findAll()).map(node => node.id))
})

async function targetNode (req, res) {
    req.targetNode = await Node.findByPk(req.params.id)
    return req.targetNode ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'Node not found' })
}

router.get('/:id', targetNode, async (req, res) => {
    let dbResources = await req.targetNode.getResources()
    res.status(200).json({
        id:          req.targetNode.id,
        endpoint:    req.targetNode.endpoint,
        online:      req.targetNode.online,
        since:       req.targetNode.since,
        resources:   dbResources.length == 0 ? undefined : await Parallel.map(dbResources, async dbResource => {
            let dbGroups = await dbResource.getResourcegroups()
            return {
                type:    dbResource.type,
                name:    dbResource.name,
                index:   dbResource.index,
                groups:  dbGroups.length == 0 ? undefined : dbGroups.map(group => group.groupId),
                alias:   await getAlias(dbResource.name)
            }
        })
    })
})

router.use(ensureAdmin)

router.put('/:id', async (req, res) => {
    let id = req.params.id
    let node = req.body
    let dbnode = await Node.findByPk(id)
    if (dbnode) {
        res.status(400).send({ message: 'Node with same id already registered' })
    } else if (node.endpoint && node.password) {
        let pit
        try {
            dbnode = await Node.create({ 
                id: id, 
                endpoint: node.endpoint,
                password: node.password,
                online: true,
                since: Date.now(),
                available: false
            })
            pit = await Pit.create()
            let result = await pitRunner.runPit(pit.id, {}, [{ 
                node:    dbnode,
                devices: { 'gpu': { type: 'gpu' } },
                script:  getScript('scan.sh')
            }])
            let resources = getResourcesFromResult(result)
            if (resources) {
                resources.forEach(async resource => {
                    await resource.save()
                    await dbnode.addResource(resource)
                })
                dbnode.online = true
                dbnode.available = true
                await dbnode.save()
                res.send()
            } else {
                throw new Error('Node scanning failed')
            }
        } catch (ex) {
            if (dbnode) {
                await dbnode.destroy()
            }
            res.status(400).send({ message: 'Problem adding node:\n' + ex })
        } finally {
            if (pit) {
                await pit.destroy()
            }
        }
    } else {
        res.status(400).send()
    }
})

router.delete('/:id', targetNode, async (req, res) => {
    await req.targetNode.destroy()
    res.send()
})

async function targetGroup (req, res) {
    req.targetGroup = await Group.findByPk(req.params.group)
    return req.targetGroup ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'Group not found' })
}

router.put('/:id/groups/:group', targetNode, targetGroup, async (req, res) => {
    for (let resource of await req.targetNode.getResources()) {
        await Resource.ResourceGroup.insertOrUpdate({ resourceId: resource.id, groupId: req.targetGroup.id })
    }
    res.send()
    clusterEvents.emit('restricted')
})

router.delete('/:id/groups/:group', targetNode, targetGroup, async (req, res) => {
    for (let resource of await req.targetNode.getResources()) {
        await Resource.ResourceGroup.destroy({ where: { resourceId: resource.id, groupId: req.targetGroup.id } })
    }
    res.send()
    clusterEvents.emit('restricted')
})

async function targetResource (req, res) {
    let targetResources = await req.targetNode.getResources({ where: { index: req.params.resource } })
    req.targetResource = targetResources.length == 1 ? targetResources[0] : undefined
    return req.targetResource ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'Resource not found' })
}

router.put('/:id/resources/:resource/groups/:group', targetNode, targetResource, targetGroup, async (req, res) => {
    await Resource.ResourceGroup.insertOrUpdate({ resourceId: req.targetResource.id, groupId: req.targetGroup.id })
    res.send()
    clusterEvents.emit('restricted')
})

router.delete('/:id/resources/:resource/groups/:group', targetNode, targetResource, targetGroup, async (req, res) => {
    await Resource.ResourceGroup.destroy({ where: { resourceId: req.targetResource.id, groupId: req.targetGroup.id } })
    res.send()
    clusterEvents.emit('restricted')
})
