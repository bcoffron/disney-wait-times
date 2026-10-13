// Stub for jsonwebtoken, used only by the tests.
// Accepts exactly one token so the handler's auth gate can pass.
export default {
  verify: function (token) {
    if (token !== 'good-token') throw new Error('invalid token');
    return { role: 'admin' };
  },
  sign: function () { return 'good-token'; }
};
