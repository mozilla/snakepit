const { getAlias } = require('../models/Alias-model.js')
const Group = require('../models/Group-model.js')
const Resource = require('../models/Resource-model.js')
const { ensureSignedIn, ensureAdmin } = require('./users.js')

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.status(200).send(Object.keys(db.nodes))
})

router.get('/:id', async (req, res) => {
    var node = db.nodes[req.params.id]
    if (node) {
        res.status(200).json({
            id:          node.id,
            endpoint:    node.endpoint,
            online:      node.online,
            since:       node.since,
            resources: Object.keys(node.resources).map(resourceId => {
                let dbResource = node.resources[resourceId]
                let resource = {
                    type:  dbResource.type,
                    name:  dbResource.name,
                    index: dbResource.index
                }
                let alias = getAlias(dbResource.name)
                if (alias) {
                    resource.alias = alias
                }
                if (dbResource.groups) {
                    resource.groups = dbResource.groups
                }
                return resource
            })
        })
    } else {
        res.status(404).send()
    }
})

router.use(ensureAdmin)

router.put('/:id', async (req, res) => {
    let id = req.params.id
    let node = req.body
    let dbnode = db.nodes[id]
    if (dbnode) {
        res.status(400).send({ message: 'Node with same id already registered' })
    } else if (node.endpoint && node.password) {
        addNode(id, node.endpoint, node.password).then(newNode => {
            setNodeState(newNode, nodeStates.ONLINE)
            res.status(200).send()
        }).catch(err => {
            res.status(400).send({ message: 'Problem adding node:\n' + err })
        })
    } else {
        res.status(400).send()
    }
})

router.delete('/:id', async (req, res) => {
    let node = db.nodes[req.params.id]
    if (node) {
        removeNode(node)
            .then(() => res.status(404).send())
            .catch(err => res.status(500).send({ message: 'Problem removing node:\n' + err }))
    } else {
        res.status(404).send()
    }
})

function targetGroup (req, res, next) {
    req.targetGroup = Group.findById(req.params.group)
    req.targetGroup ? next() : res.status(404).send()
}

router.put('/:id/groups/:group', targetGroup, async (req, res) => {
    await req.targetNode.addGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('changedNodeRights', req.targetNode.id)
})

router.delete('/:id/groups/:group', targetGroup, async (req, res) => {
    await req.targetNode.removeGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('changedNodeRights', req.targetNode.id)
})

function targetResource (req, res, next) {
    req.targetResource = Resource.findOne({ where: { node: req.targetNode, index: req.params.resource } })
    req.targetResource ? next() : res.status(404).send()
}

router.put('/:id/resources/:resource/groups/:group', targetResource, targetGroup, async (req, res) => {
    await req.targetResource.addGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('changedNodeRights', req.targetNode.id)
})

router.delete('/:id/resources/:resource/groups/:group', targetResource, targetGroup, async (req, res) => {
    await req.targetResource.removeGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('changedNodeRights', req.targetNode.id)
})
