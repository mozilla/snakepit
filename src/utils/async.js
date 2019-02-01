var exports = module.exports = {}

exports.to = function (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

exports.sleep = function (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}