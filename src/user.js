const shared = require('shared')
const config = require('config')

var exports = module.exports = {}

exports.register = function(email) {
    return shared.OK
}

exports.delete = function(email) {
    return shared.OK
}

exports.renew = function(email) {
    return shared.OK
}

exports.addToGroup = function(email, group) {
    return shared.OK
}

exports.removeFromGroup = function(email, group) {
    return shared.OK
}

exports.list = function() {
    return shared.OK
}

exports.info = function(email) {
    return shared.OK
}