FROM node:14

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

RUN cp config.template.json dist/config.json
RUN cp emulator_balances.json dist/emulator_balances.json
RUN cp src/logo.png dist/logo.png
RUN cp src/icon.png dist/icon.png

WORKDIR dist

CMD [ "node", "main.js" ]