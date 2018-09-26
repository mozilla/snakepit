const fslib = require('httpfslib')
const store = require('./store.js')
const jobfs = require('./jobfs.js')
const config = require('./config.js')
const { EventEmitter } = require('events')
var exports = module.exports = new EventEmitter()
var db = store.root

function _emitRestricted() {
    exports.emit('restricted')
}

function _emitEntityChange(entityType, entity) {
    exports.emit('changed', entityType, entity)
}

function _addGroup(entity, req, res, callback) {
    if (entity) {
        if (req.user.admin || req.user.id == entity.user) {
            let group = req.params.group
            if (entity.groups) {
                let index = entity.groups.indexOf(group)
                if (index >= 0) {
                    res.status(400).send('Already in group')
                } else {
                    entity.groups.push(group)
                    res.status(200).send()
                    callback && callback(entity)
                }
            } else {
                entity.groups = [ group ]
                res.status(200).send()
            }
        } else {
            res.status(403).send()
        }
    } else {
        res.status(404).send()
    }
}

function _removeGroupByIndex(entity, index) {
    entity.groups.splice(index, 1)
    if (entity.groups.length == 0) {
        delete entity.groups
    }
}

function _removeGroup(entity, req, res, callback) {
    if (entity) {
        if (req.user.admin || req.user.id == entity.user) {
            let group = req.params.group
            let index = entity.groups ? entity.groups.indexOf(group) : -1
            if (index >= 0) {
                _removeGroupByIndex(entity, index)
                res.status(200).send()
                callback && callback(entity)
            } else {
                res.status(400).send('Not in group')
            }
        } else {
            res.status(403).send()
        }
    } else {
        res.status(404).send()
    }
}

function _getResource(req) {
    let node = db.nodes[req.params.node]
    return node && node.resources[req.params.resource]
}

function _getGroups(groups, collection) {
    for (let entity of Object.keys(collection).map(k => collection[k])) {
        if (entity.groups) {
            for (let group of entity.groups) {
                groups[group] = true
            }
        }
    }
}

exports.initApp = function(app) {
    app.get('/groups', function(req, res) {
        if (req.user.admin) {
            let groups = {}
            for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
                _getGroups(groups, node.resources || {})
            }
            _getGroups(groups, db.users)
            _getGroups(groups, db.jobs)
            res.status(200).json(Object.keys(groups))
        } else {
            res.status(403).send()
        }
    })

    app.post('/groups/:group/fs', function(req, res) {
        if (req.user.groups.includes(group)) {
            let chunks = []
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => fslib.serve(
                fslib.real(jobfs.getGroupDir(group)), 
                Buffer.concat(chunks), 
                result => res.send(result), config.debugJobFS)
            )
        } else {
            res.status(403).send()
        }
    })

    app.post('/shared', function(req, res) {
        let chunks = []
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => fslib.serve(
            fslib.readOnly(fslib.real(jobfs.sharedDir)), 
            Buffer.concat(chunks), 
            result => res.send(result), config.debugJobFS)
        )
    })

    app.put('/users/:user/groups/:group', function(req, res) {
        _addGroup(db.users[req.params.user], req, res, entity => {
            _emitEntityChange('user', entity)  
        })
    })

    app.delete('/users/:user/groups/:group', function(req, res) {
        _removeGroup(db.users[req.params.user], req, res, entity => {
            _emitEntityChange('user', entity)
            _emitRestricted()
        })
    })

    app.put('/jobs/:job/groups/:group', function(req, res) {
        _addGroup(db.jobs[req.params.job], req, res, entity => {
            _emitEntityChange('job', entity)
        })
    })

    app.delete('/jobs/:job/groups/:group', function(req, res) {
        _removeGroup(db.jobs[req.params.job], req, res, entity => {
            _emitEntityChange('job', entity)
            _emitRestricted()
        })
    })

    app.put('/nodes/:node/resources/:resource/groups/:group', function(req, res) {
        _addGroup(_getResource(req), req, res, entity => {
            _emitEntityChange('resource', entity)
        })
    })

    app.delete('/nodes/:node/resources/:resource/groups/:group', function(req, res) {
        _removeGroup(_getResource(req), req, res, entity => {
            _emitEntityChange('resource', entity)
            _emitRestricted()
        })
    })

    app.put('/nodes/:node/groups/:group', function(req, res) {
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

    app.delete('/nodes/:node/groups/:group', function(req, res) {
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
}

exports.canAccessResource = function (user, resource) {
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

exports.canAccessJob = function (user, job) {
    if (user.admin || user.id == job.user) {
        return true
    }
    if (job.groups && user.groups) {
        for (let group of user.groups) {
            if (job.groups.includes(group)) {
                return true
            }
        }
    }
    return false
}