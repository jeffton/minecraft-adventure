const frame = document.querySelector('#world-map');

const observer = new IntersectionObserver(([entry]) => {
  if (entry.isIntersecting && entry.intersectionRatio >= 0.01) {
    if (!frame.hasAttribute('src')) frame.src = frame.dataset.src;
  } else {
    frame.removeAttribute('src');
  }
}, { rootMargin: '0px', threshold: 0.01 });

observer.observe(frame);
