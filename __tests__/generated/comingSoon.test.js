const express = require('express');
const request = require('supertest');
const comingSoon = require('../../routes/comingSoon');

describe('comingSoon route middleware', () => {
  // Middleware to stub res.render so tests don't need actual view templates
  function stubRenderMiddleware(req, res, next) {
    // override render to return JSON describing the render call
    res.render = function (view, locals) {
      if (typeof locals === 'undefined') locals = {};
      return res.json({ view, locals });
    };
    next();
  }

  test('renders coming-soon with default page name and sets 200', async () => {
    const app = express();
    app.get('/default', stubRenderMiddleware, comingSoon());

    const res = await request(app).get('/default');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('view', 'coming-soon');
    expect(res.body).toHaveProperty('locals');
    expect(res.body.locals).toMatchObject({
      pageTitle: 'This page',
      activePage: 'coming-soon',
      currentView: 'coming-soon',
      showFilters: false,
    });
  });

  test('renders coming-soon with custom page name', async () => {
    const app = express();
    app.get('/custom', stubRenderMiddleware, comingSoon('My Special Page'));

    const res = await request(app).get('/custom');

    expect(res.status).toBe(200);
    expect(res.body.view).toBe('coming-soon');
    expect(res.body.locals.pageTitle).toBe('My Special Page');
  });
});
