/* Reuse the existing catalogue search, account button and blind-choice game. */
(() => {
  const headerSearch=document.getElementById('home-search');
  headerSearch.addEventListener('input',()=>{
    search.value=headerSearch.value;
    search.dispatchEvent(new Event('input',{bubbles:true}));
  });
  search.addEventListener('input',()=>{headerSearch.value=search.value});
  document.getElementById('home-search-form').addEventListener('submit',event=>{
    event.preventDefault();
    document.getElementById('archive').scrollIntoView({block:'start',behavior:reducedMotion.matches?'instant':'smooth'});
    search.focus({preventScroll:true});
  });
  document.querySelectorAll('[data-open-blind]').forEach(link=>link.addEventListener('click',()=>{
    const card=document.getElementById('blind-body').closest('.game-card');
    card.classList.add('expanded');
    card.querySelector('.game-toggle').setAttribute('aria-expanded','true');
    if(link.hasAttribute('data-random-blind'))document.getElementById('blind-pick').click();
  }));
  document.querySelectorAll('[data-open-challenge]').forEach(link=>link.addEventListener('click',()=>{
    const card=document.getElementById('challenge-body').closest('.game-card');
    card.classList.add('expanded');
    card.querySelector('.game-toggle').setAttribute('aria-expanded','true');
  }));
  const hero=document.querySelector('.home-hero');
  const updateMascot=()=>{
    document.documentElement.style.setProperty('--home-mascot-opacity',hero.getBoundingClientRect().bottom<0?'0.97':'0');
  };
  window.addEventListener('scroll',updateMascot,{passive:true});
  updateMascot();
})();
