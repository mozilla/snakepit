const jwt = require('jsonwebtoken')

const config = require('../config.js')
const Alias = require('../models/Alias-model.js')
const Group = require('../models/Group-model.js')
const Job   = require('../models/Job-model.js')
const Node  = require('../models/Node-model.js')
const User  = require('../models/User-model.js')

const log  = require('../utils/logger.js')
const parseDuration = require('parse-duration')

var exports = module.exports = {}

async function targetAlias (req, res, ensure) {
    if (!/^[a-z][a-z0-9]*$/.test(req.params.alias)) {
        return Promise.reject({ code: 400, message: 'Wrong alias format' })
    }
    req.targetAlias = await Alias.findByPk(req.params.alias)
    if (ensure && !req.targetAlias) {
        return Promise.reject({ code: 404, message: 'Alias not found'})
    }
    return Promise.resolve('next')
}
exports.tryTargetAlias = (req, res) => targetAlias(req, res, false)
exports.targetAlias    = (req, res) => targetAlias(req, res, true)

async function targetGroup (req, res, ensure) {
    if(!/^[a-z]+$/.test(req.params.group)) {
        return Promise.reject({ code: 400, message: 'Wrong group id format' })
    }
    req.targetGroup = await Group.findByPk(req.params.group)
    if (ensure && !req.targetGroup) {
        return Promise.reject({ code: 404, message: 'Group not found'})
    }
    return Promise.resolve('next')
}
exports.tryTargetGroup = (req, res) => targetGroup(req, res, false)
exports.targetGroup    = (req, res) => targetGroup(req, res, true)

async function targetJob (req, res, ensure) {
    if(!/^[0-9]+$/.test(req.params.job)) {
        return Promise.reject({ code: 400, message: 'Wrong job id format' })
    }
    req.targetJob = await Job.findByPk(req.params.job)
    if (ensure && !req.targetJob) {
        return Promise.reject({ code: 404, message: 'Job not found'})
    }
    return Promise.resolve('next')
}
exports.tryTargetJob = (req, res) => targetJob(req, res, false)
exports.targetJob    = (req, res) => targetJob(req, res, true)

async function targetInstance (req, res) {
    if(!/^([0-9]+)$/.test(req.params.instance)) {
        return Promise.reject({ code: 400, message: 'Wrong instance id format' })
    }
    req.targetInstance = req.params.instance
    return Promise.resolve('next')
}
exports.targetInstance = targetInstance

async function targetNode (req, res, ensure) {
    if (!/^[a-z][a-z0-9]*$/.test(req.params.node)) {
        return Promise.reject({ code: 400, message: 'Wrong node id format' })
    }
    req.targetNode = await Node.findByPk(req.params.node)
    if (ensure && !req.targetNode) {
        return Promise.reject({ code: 404, message: 'Node not found'})
    }
    return Promise.resolve('next')
}
exports.tryTargetNode = (req, res) => targetNode(req, res, false)
exports.targetNode    = (req, res) => targetNode(req, res, true)

async function targetUser (req, res, ensure) {
    let id = req.params.user
    if (req.user && id == '~') {
        req.targetUser = req.user
    } else {
        if (!/^[a-z][a-z0-9]*$/.test(req.params.user)) {
            return Promise.reject({ code: 400, message: 'Wrong user id format' })
        }
        req.targetUser = await User.findByPk(id)
    }
    if (ensure && !req.targetUser) {
        return Promise.reject({ code: 404, message: 'User not found'})
    }
    return Promise.resolve('next')
}
exports.tryTargetUser = (req, res) => targetUser(req, res, false)
exports.targetUser    = (req, res) => targetUser(req, res, true)

function signIn (req, res, ensure) {
    return new Promise((resolve, reject) => {
        const msgAut = 'Authentication:'
        let token = req.get('X-Auth-Token')
        if (token) {
            jwt.verify(token, config.tokenSecret, (err, decoded) => {
                if (err) {
                    if (err.name == 'TokenExpiredError') {
                        const msgExp = 'Token expired'
                        log.debug(msgAut, msgExp)
                        res.status(401).json({ message: msgExp })
                    } else {
                        const msgInv = 'Invalid token'
                        log.error(msgAut, msgInv)
                        res.status(400).json({ message: msgInv })
                    }
                    resolve()
                } else {
                    if (decoded.exp > (new Date().getTime() + config.tokenTTL) / 1000) {
                        const msgTTL = 'Token expiration too far in the future'
                        log.error(msgAut, msgTTL, '- User:', decoded.user)
                        res.status(401).json({ message: msgTTL })
                        resolve()
                    } else {
                        User.findByPk(decoded.user).then(user => {
                            if (user) {
                                log.debug(msgAut, 'Token verification successful', decoded)
                                req.user = user
                                resolve('next')
                            } else {
                                const msgUnk = 'Token for unknown user'
                                log.error(msgAut, msgUnk, decoded.user)
                                res.status(401).json({ message: msgUnk })
                                resolve()
                            }
                        })
                    }
                }
            })
        } else if (ensure) {
            let msgNT = 'No token'
            log.error(msgAut, msgNT)
            res.status(401).json({ message: msgNT })
            resolve()
        } else {
            resolve('next')
        }
    })
}
exports.trySignIn      = (req, res) => signIn(req, res, false)
exports.ensureSignedIn = (req, res) => signIn(req, res, true)
exports.ensureAdmin    = (req, res, next) => {
    let checkAdmin = () => req.user.admin ? next() : res.status(403).send()
    req.user ? checkAdmin() : signIn(req, res, true).then(checkAdmin)
}
exports.selfOrAdmin    = (req, res) => (req.user.id == req.targetUser.id || req.user.admin) ?
    Promise.resolve('next') :
    Promise.reject({ code: 403, message: 'Forbidden' })
exports.memberOrAdmin  = async (req, res) => (req.user.admin || await req.user.isMemberOf(req.targetGroup)) ?
    Promise.resolve('next') :
    Promise.reject({ code: 403, message: 'Forbidden' })

exports.ensureUpgrade  = (req, res, next) => res.openSocket ?
    Promise.resolve('next') :
    Promise.reject({ code: 404, message: 'Only web-socket upgrades' })