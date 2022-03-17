import alines from './alines.mjs';

alines.startServer('pass');
console.log('response', await alines.openMenu('1', ['A', 'B', 'C']));
console.log('response', await alines.openMenu('2', ['A', 'B', 'C']));
console.log('response', await alines.openMenu('3', ['A', 'B', 'C']));
alines.stopServer();
