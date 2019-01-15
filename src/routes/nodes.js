const Router = require('express-promise-router')

const clusterEvents = require('../utils/clusterEvents.js')
const pitRunner = require('../pitRunner.js')
const Pit = require('../models/Pit-model.js')
const Node = require('../models/Node-model.js')
const Group = require('../models/Group-model.js')
const Resource = require('../models/Resource-model.js')
const log = require('../utils/logger.js')
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
                log.debug('FOUND RESOURCE', id, resource)
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

function targetNode (req, res, next) {
    req.targetNode = Node.findByPk(req.params.id)
    req.targetNode ? next() : res.status(404).send()
}

router.get('/:id', targetNode, async (req, res) => {
    res.status(200).json({
        id:          req.targetNode.id,
        endpoint:    req.targetNode.endpoint,
        online:      req.targetNode.online,
        since:       req.targetNode.since,
        resources:   (await req.targetNode.getResources()).map(async dbResource => ({
            type:    dbResource.type,
            name:    dbResource.name,
            index:   dbResource.index,
            groups:  (await dbResource.getGroups()).map(group => group.id),
            alias:   await getAlias(dbResource.name)
        }))
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
            log.debug('ADDING NODE', id, workers)
            let resources = getResourcesFromResult(result)
            if (resources) {
                resources.forEach(async resource => await resource.save())
                node.online = true
                node.available = true
                await node.save()
                res.send()
            } else {
                throw new Error('Node scanning failed')
            }
        } catch (ex) {
            log.debug('ADDING NODE FAILED', ex)
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

function targetGroup (req, res, next) {
    req.targetGroup = Group.findByPk(req.params.group)
    req.targetGroup ? next() : res.status(404).send()
}

router.put('/:id/groups/:group', targetNode, targetGroup, async (req, res) => {
    await req.targetNode.addGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('restricted')
})

router.delete('/:id/groups/:group', targetNode, targetGroup, async (req, res) => {
    await req.targetNode.removeGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('restricted')
})

function targetResource (req, res, next) {
    req.targetResource = Resource.findOne({ where: { node: req.targetNode, index: req.params.resource } })
    req.targetResource ? next() : res.status(404).send()
}

router.put('/:id/resources/:resource/groups/:group', targetNode, targetResource, targetGroup, async (req, res) => {
    await req.targetResource.addGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('restricted')
})

router.delete('/:id/resources/:resource/groups/:group', targetNode, targetResource, targetGroup, async (req, res) => {
    await req.targetResource.removeGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('restricted')
})
