// Firebase do Rainbow Pub (projeto rainbowpub-ecd71). A config web é pública por natureza;
// quem protege os dados são as regras em firestore.rules.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: 'AIzaSyCmPEoLaYQFNTIkp7Qi2kWAMb3-t_8E5G8',
  authDomain: 'rainbowpub-ecd71.firebaseapp.com',
  projectId: 'rainbowpub-ecd71',
  storageBucket: 'rainbowpub-ecd71.firebasestorage.app',
  messagingSenderId: '477700215704',
  appId: '1:477700215704:web:3516d3780dabccca63d1ed',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Teste local com o emulador do Firebase: abrir http://127.0.0.1:PORTA/?emu=1 (nunca em produção).
export const emu = ['127.0.0.1', 'localhost'].includes(location.hostname) && new URLSearchParams(location.search).has('emu');
if (emu) connectFirestoreEmulator(db, '127.0.0.1', 8080);
export const SDK = 'https://www.gstatic.com/firebasejs/10.13.0';
