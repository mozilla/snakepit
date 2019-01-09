const Router = require('express-promise-router')

const config = require('../config.js')
const fslib = require('../utils/httpfs.js')
const { ensureSignedIn, ensureAdmin } = require('./users.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

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
        let group = req.params.group
        if (req.user.groups.includes(group)) {
            let chunks = []
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => fslib.serve(
                fslib.real(exports.getGroupDir(group)), 
                Buffer.concat(chunks), 
                result => res.send(result), config.debugJobFS)
            )
        } else {
            res.status(403).send()
        }
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

    
}
