import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { Client } from 'boardgame.io/react';
import { HnefataflGame } from './HnefataflGame';
import { HnefataflBoard } from './HnefataflBoard';
import reportWebVitals from './reportWebVitals';

const HnefataflClient = Client({
  game: HnefataflGame,
  board: HnefataflBoard,
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <HnefataflClient />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
