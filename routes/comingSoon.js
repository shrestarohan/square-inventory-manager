// routes/comingSoon.js
module.exports = function comingSoon(pageName = 'This page') {
  return (req, res) => {
    res.status(200).render('coming-soon', {
      pageTitle: pageName,
      activePage: 'coming-soon',
      currentView: 'coming-soon',
      showFilters: false, // hide search/merchant filters
    });
  };
};
