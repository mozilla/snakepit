const db = require('./database.js')
const utils = require('./utils.js')
const { EventEmitter } = require('events')
var exports = module.exports = new EventEmitter()

const entityTypes = {
    'user': 'TEXT',
    'resource': 'TEXT', 
    'job': 'INT'
}

function _emitRestricted() {
    exports.emit('restricted')
}

function _checkAccess(entityType, entityId, req, res, callback) {
    utils.exists(db, entityType + 's', entityId, exists => {
        if (exists) {
            if (req.user.admin) {
                callback()
            } else if (entityType == 'job') {
                utils.getField(db, 'jobs', entityId, 'user', value => {
                    if (req.user.id == value) {
                        callback()
                    } else {
                        res.status(403).send()
                    }
                })
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })
}

function _addGroup(entityType, entityId, req, res) {
    _checkAccess(entityType, entityId, req, res, () => {
        db.run('INSERT OR REPLACE INTO ' + entityType + '_groups (' + entityType + ', group) VALUES ($entityId, $group)', {
            $entityId: entityId,
            $group: req.params.group
        })
    })
}

function _removeGroup(entityType, entityId, req, res) {
    _checkAccess(entityType, entityId, req, res, () => {
        db.run('DELETE FROM ' + entityType + '_groups WHERE ' + entityType + ' == $entityId AND group == $group', {
            $entityId: entityId,
            $group: req.params.group
        })
    })
}

function _getResource(req, res, callback) {
    if (req.user.admin) {
        db.get('SELECT id AS Result FROM resources WHERE node == $node AND type == $type AND index == $index', { 
            $node: req.params.node,
            $type: req.params.type,
            $index: req.params.index
        }, (err, result) => {
            if (result) {
                callback(result.id)
            } else {
                res.status(404).send()
            }
        })
    } else {
        res.status(403).send()
    }
}

exports.initApp = function(app) {
    app.get('/groups', function(req, res) {
        if (req.user.admin) {
            let groups = []
            db.each('SELECT group FROM groups', (err, result) => {
                if (result) {
                    groups.push(result.group)
                }
            })
            res.status(200).json(groups)
        } else {
            res.status(403).send()
        }
    })

    app.put('/users/:user/groups/:group', function(req, res) {
        _addGroup('user', req.params.user, req, res)
    })

    app.delete('/users/:user/groups/:group', function(req, res) {
        _removeGroup('user', req.params.user, req, res)
        _emitRestricted()
    })

    app.put('/jobs/:job/groups/:group', function(req, res) {
        _addGroup('job', req.params.job, req, res)
    })

    app.delete('/jobs/:job/groups/:group', function(req, res) {
        _removeGroup('job', req.params.job, req, res)
        _emitRestricted()
    })

    app.put('/nodes/:node/type:type/index/:index/groups/:group', function(req, res) {
        _getResource(req, res, id => {
            _addGroup('resource', id, req, res)
        })
    })

    app.delete('/nodes/:node/resources/:resource/groups/:group', function(req, res) {
        _getResource(req, res, id => {
            _removeGroup('resource', id, req, res)
            _emitRestricted()
        })
    })

    app.put('/nodes/:node/groups/:group', function(req, res) {
        if (req.user.admin) {
            utils.exists(db, 'nodes', req.params.node, exists => {
                if (exists) {
                    db.run('INSERT OR REPLACE INTO resource_groups (resource, group) SELECT id, "$group" FROM resources WHERE node == $node', {
                        $node: req.params.node,
                        $group: req.params.group
                    })
                    res.status(200).send()
                } else {
                    res.status(404).send()
                }
            })
        } else {
            res.status(403).send()
        }
    })

    app.delete('/nodes/:node/groups/:group', function(req, res) {
        if (req.user.admin) {
            utils.exists(db, 'nodes', req.params.node, exists => {
                if (exists) {
                    db.run('DELETE FROM resource_groups WHERE node == $node AND group == $group', {
                        $node: req.params.node,
                        $group: req.params.group
                    })
                    res.status(200).send()
                } else {
                    res.status(404).send()
                }
            })
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