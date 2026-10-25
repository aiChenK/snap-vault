/**
 * 携带 HTTP 状态码的业务错误
 * 路由层通过 next(err) 汇聚到统一错误处理器, 处理器直接采用 err.status 作为响应码
 */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

module.exports = { ApiError };
