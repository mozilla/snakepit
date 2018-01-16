const shared = require('shared')
const config = require('config')

var exports = module.exports = {}

exports.register = function(name, address, serviceUser, computeUser, gpus) {
    return shared.OK
}

exports.delete = function(name) {
    return shared.OK
}

exports.list = function(collection) {
    return shared.OK
}

exports.info = function(name) {
    return shared.OK
}
