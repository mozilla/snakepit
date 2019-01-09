const { getAlias } = require('../models/Alias-model.js')

router.put('/:id', async (req, res) => {
    if (req.user.admin) {
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
    } else {
        res.status(403).send()
    }
})

router.get('/', async (req, res) => {
    res.status(200).send(Object.keys(db.nodes))
})

router.get('/:id', async (req, res) => {
    var node = db.nodes[req.params.id]
    if (node) {
        res.status(200).json({
            id:          node.id,
            endpoint:    node.endpoint,
            state:       node.state,
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

router.delete('/:id', async (req, res) => {
    if (req.user.admin) {
        let node = db.nodes[req.params.id]
        if (node) {
            removeNode(node)
                .then(() => res.status(404).send())
                .catch(err => res.status(500).send({ message: 'Problem removing node:\n' + err }))
        } else {
            res.status(404).send()
        }
    } else {
        res.status(403).send()
    }
})

router.put('/:id/groups/:group', (req, res) => {
    if (req.user.admin) {
        let node = db.nodes[req.params.node]
        if (node) {
            let group = req.params.group
            for (let resource of Object.keys(node.resources).map(k => node.resources[k])) {
                if (resource.groups) {
                    if (!resource.groups.includes(group)) {
                        resource.groups.push(group)
                        _emitEntityChange('resource', resource)
                    }
                } else {
                    resource.groups = [ group ]
                }
            }
            res.status(200).send()
        } else {
            res.status(404).send()
        }
    } else {
        res.status(403).send()
    }
})

router.delete('/:node/groups/:group', (req, res) => {
    if (req.user.admin) {
        let node = db.nodes[req.params.node]
        if (node) {
            let group = req.params.group
            for (let resource of Object.keys(node.resources).map(k => node.resources[k])) {
                let index = resource.groups ? resource.groups.indexOf(group) : -1
                if (index >= 0) {
                    _removeGroupByIndex(resource, index)
                    _emitEntityChange('resource', resource)
                }
            }
            res.status(200).send()
        } else {
            res.status(404).send()
        }
    } else {
        res.status(403).send()
    }
    _emitRestricted()
})
