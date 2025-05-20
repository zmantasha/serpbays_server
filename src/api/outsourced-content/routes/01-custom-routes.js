module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/outsourced-contents/order/:id',
      handler: 'outsourced-content.findByOrder',
      config: {
        policies: [],
        middlewares: []
      }
    }
  ]
}; 