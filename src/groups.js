const store = require('./store.js')
//const { resimulateWaitingJobs } = require('./jobs.js')

var exports = module.exports = {}
var db = store.root

function _addGroup(entity, req, res) {
    if (req.user.admin) {
        if (entity) {
            let group = req.params.group
            if (entity.groups) {
                let index = entity.groups.indexOf(group)
                if (index >= 0) {
                    res.status(400).send('Already in group')
                } else {
                    entity.groups.push(group)
                    res.status(200).send()
                }
            } else {
                entity.groups = [ group ]
                res.status(200).send()
            }
        } else {
            res.status(404).send()
        }
    } else {
        res.status(403).send()
    }
}

function _removeGroupByIndex(entity, index) {
    entity.groups.splice(index, 1)
    if (entity.groups.length == 0) {
        delete entity.groups
    }
}

function _removeGroup(entity, req, res) {
    if (req.user.admin) {
        if (entity) {
            let group = req.params.group
            let index = entity.groups ? entity.groups.indexOf(group) : -1
            if (index >= 0) {
                _removeGroupByIndex(entity, index)
                res.status(200).send()
            } else {
                res.status(400).send('Not in group')
            }
        } else {
            res.status(404).send()
        }
    } else {
        res.status(403).send()
    }
}

function _getResource(req) {
    let node = db.nodes[req.params.node]
    return node && node.resources[req.params.resource]
}

exports.initApp = function(app) {
    app.get('/groups', function(req, res) {
        if (req.user.admin) {
            let groups = {}
            for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
                for (let resource of node.resources) {
                    if (resource.groups) {
                        for (let group of resource.groups) {
                            groups[group] = true
                        }
                    }
                }
            }
            for (let user of Object.keys(db.users).map(k => db.users[k])) {
                if (user.groups) {
                    for (let group of user.groups) {
                        groups[group] = true
                    }
                }
            }
            res.status(200).json(Object.keys(groups))
        } else {
            res.status(403).send()
        }
    })

    app.put('/users/:user/groups/:group', function(req, res) {
        _addGroup(db.users[req.params.user], req, res)
    })

    app.delete('/users/:user/groups/:group', function(req, res) {
        _removeGroup(db.users[req.params.user], req, res)
        resimulateWaitingJobs()
    })

    app.put('/nodes/:node/resources/:resource/groups/:group', function(req, res) {
        _addGroup(_getResource(req), req, res)
    })

    app.delete('/nodes/:node/resources/:resource/groups/:group', function(req, res) {
        _removeGroup(_getResource(req), req, res)
        resimulateWaitingJobs()
    })

    app.put('/nodes/:node/groups/:group', function(req, res) {
        if (req.user.admin) {
            let node = db.nodes[req.params.node]
            if (node) {
                let group = req.params.group
                for (let resource of node.resources) {
                    if (resource.groups) {
                        if (!resource.groups.includes(group)) {
                            resource.groups.push(group)
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

    app.delete('/nodes/:node/groups/:group', function(req, res) {
        if (req.user.admin) {
            let node = db.nodes[req.params.node]
            if (node) {
                let group = req.params.group
                for (let resource of node.resources) {
                    let index = resource.groups ? resource.groups.indexOf(group) : -1
                    if (index >= 0) {
                        _removeGroupByIndex(resource, index)
                    }
                }
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
        resimulateWaitingJobs()
    })
}

exports.canAccess = function (user, resource) {
    if (resource.groups) {
        if (user.groups) {
            for (let group of user.groups) {
                if (resource.groups.includes(group)) {
                    return true
                }
            }
        }
        return false
    }
    return true
}